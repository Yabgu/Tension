# Interop surface — scoping against C#

**Status:** scoping only. No source changed, no plan, no code.
**Base:** Tension `phase/interop-struct-impl` @ `62b4da1` (the struct phase's
branch); TensionScript published `0.7.1`, and the canonical checkout at
`/home/acakar/work/as-inspect/assemblyscript` (branch
`phase/interop-struct-std`, which now carries `COPY_STRUCT`).
**Method:** C# claims are cited to the .NET documentation, fetched and read —
not inherited from the dispatch. TensionScript claims are measured: compiled
with the published `0.7.1` to WAT, and where a runtime answer was needed, run on
the real host (`tension-core/target/debug`, `--runtime incremental`). Fixtures
live in `/tmp/surfprobe/`; none is in the repo.

**What this document is not.** It does not revisit the settled record: the root
cause (class ≡ `usize` → `byteSize` 4 → `sizeof` 4, `load`/`store` emit width-4),
`COPY_STRUCT` as the fix shape, the `SessionInfo` correction, `T[N]` as a 0.8.0
candidate, or the hash verification. It tests the architect's goal — *interop as
clean as C#'s* — against what the tree actually does.

---

## 0. The headline, before the tables

Three measurements change the shape of the question:

1. **Field access already compiles to hand-rolled arithmetic — at
   `--optimizeLevel 1` or above.** At the level the tree's build configuration
   actually uses (0), every field access is a call to a three-instruction
   accessor. At `-O1` the accessor is inlined away and `p.b` becomes
   `local.get $0; f32.load offset=4` — **two instructions, one fewer than the
   hand-rolled `i32.const 4; i32.add` form**. The "C# is free because the JIT
   inlines `foo.data[i]`" property is therefore **already available**, and the
   lever is a build flag, not a compiler change (§2.1).
2. **The ABI is already `(ptr,len)`-shaped.** The adapter contract passes
   `uint32_t ptr, uint32_t len` for every buffer sweep
   (`tension_adapter.h:184`, `:192`, `:232`, `:331`). A Span-equivalent is
   therefore **guest-side work only** — no ABI change, no hash move (§2.4).
3. **The gap that remains is small and syntactic**: `T[N]` does not parse, and
   there is no sized view over raw memory whose `.length` means what the caller
   means (§2.3). Both are compiler/std features; neither is blocked by codegen.

---

## 1. The C# feature inventory

Fetched 2026-10-22 from `learn.microsoft.com`. "N/A" means the feature exists to
solve a problem WASM does not have; the reason is given.

### 1.1 Layout

| feature | what it is for | source | in WASM/TensionScript? |
|---|---|---|---|
| `[StructLayout(LayoutKind.Sequential)]` | "Lets you control the physical layout of the data fields of a class or structure in memory"; `Sequential` "force[s] the members to be laid out sequentially in the order they appear" | StructLayoutAttribute, Remarks | **equivalent by default**: an `@unmanaged` class's declaration order *is* its layout (`src/resolver.ts:3676-3684`) |
| `[StructLayout(LayoutKind.Explicit)]` + `[FieldOffset(n)]` | "Indicates the physical position of fields within the unmanaged representation"; used for unions and hand-placed fields | FieldOffsetAttribute; LayoutKind | **no equivalent** — and, measured, an unknown `@fieldOffset(16)` is **silently ignored**, leaving declaration-order layout (§2.5) |
| `[StructLayout(..., Size = n)]` | pads the type to a fixed total size | StructLayoutAttribute, `Size` property | **spelled out**: explicit `reserved*` fields (`runtime/wire.ts:121-154`) |
| `[MarshalAs(ByValArray, SizeConst = n)]` | an inline array *in the marshalled form* | MarshalAsAttribute | **no equivalent** (§1.2, `T[N]`) |

### 1.2 Sizes and offsets

| feature | what it is for | source | TensionScript |
|---|---|---|---|
| `sizeof(T)` (unsafe) | "returns the number of bytes occupied by a variable of a given type"; in safe code only primitives; "In unsafe code, you can use `sizeof` on any non-void type" | sizeof operator | **`sizeof<T>` exists but returns the *value* width** — 4 for any class (`builtins.ts:1243`) |
| `Unsafe.SizeOf<T>()` | same, without the unsafe context | Unsafe.SizeOf | same as above |
| `Marshal.SizeOf<T>()` | "the unmanaged size, in bytes" — runtime introspection | Marshal.SizeOf | **`offsetof<T>()`** returns the layout size, at compile time (`builtins.ts:1330`) |
| `Marshal.OffsetOf<T>(name)` | "the field offset of the unmanaged form" — runtime | Marshal.OffsetOf | **`offsetof<T>("name")`**, compile-time (`builtins.ts:1306-1321`) |

The C# pair splits along *runtime vs compile time*; TensionScript has only the
compile-time form. That is a difference in mechanism, not in capability, for
static layouts. There is no runtime reflection in TensionScript, so
`Marshal.SizeOf(typeof(T))` on a type only known at runtime has no analogue —
which is consistent with the language having no runtime type objects to ask.

### 1.3 Inline arrays

| feature | what it is for | source | TensionScript |
|---|---|---|---|
| `[InlineArray(N)]` (.NET 8) | "the instance's storage is sequentially replicated Length times"; attribute on a struct "with a single field", runtime replicates it — e.g. `[InlineArray(8)] struct Float8InlineArray { private float _value; }` | InlineArrayAttribute | **absent**: `T[N]` is `TS1005`; `StaticArray<T,N>` is `TS1110` (§2.2) |
| `fixed T buf[N]` | a fixed-size buffer *inside* a struct, for interop; "requires an unsafe context" | unsafe code, fixed-size buffers | **absent**, same reasons |
| `[MarshalAs(ByValArray, SizeConst=N)]` | marshals a managed array as inline storage | MarshalAsAttribute | **absent** |

### 1.4 Views and raw access

| feature | what it is for | source | TensionScript |
|---|---|---|---|
| `Span<T>` | "a type-safe and memory-safe representation of a contiguous region of arbitrary memory"; a `ref struct` "allocated on the stack", which cannot be boxed, be a field in a reference type, or cross `await`/`yield` | Span&lt;T&gt; | **absent**; the nearest thing is an unchecked `StaticArray` view whose `.length` is wrong (§2.3) |
| `MemoryMarshal.Cast<TFrom,TTo>` | "casts a span of one primitive type to a span of another primitive type" | MemoryMarshal.Cast | **`changetype<T>` + arithmetic**, hand-written |
| `MemoryMarshal.GetReference` | a `ref` to element 0 | GetReference | **`changetype<usize>` of the pointer** |
| `Unsafe.As<TFrom,TTo>` | "conceptually similar to C++'s `reinterpret_cast<>`"; "It is the caller's responsibility to ensure that the cast is legal" | Unsafe.As | **`changetype<T>(x)`** |
| `Unsafe.Add` | element-offset pointer arithmetic | Unsafe.Add | **`p + i * sizeof`**, hand-written |
| `Unsafe.ByteOffset` | byte distance between two pointers | Unsafe.ByteOffset | pointer subtraction |

### 1.5 Copy

| feature | what it is for | source | TensionScript |
|---|---|---|---|
| `Buffer.MemoryCopy(src, dst, dstSize, srcBytes)` | "Copies a block of memory" with an explicit destination capacity | Buffer.MemoryCopy | **`memory.copy(dst, src, n)`** (bulk-memory, `builtins.ts:3361-3385`) — no destination-capacity parameter |
| `Buffer.BlockCopy` | copies between arrays, byte-wise | Buffer.BlockCopy | `memory.copy` over `dataStart` |
| `Marshal.Copy` | managed array ↔ unmanaged pointer | Marshal.Copy | `memory.copy` (+ `__link` when the element is a managed reference) |
| the missing one | — | — | **`COPY_STRUCT<T>(dst, src)`** = `memory.copy(dst, src, offsetof<T>())`, the struct copy; added in the companion PR |

### 1.6 GC, strings, and stubs — the N/A block

| feature | purpose in .NET | why N/A here |
|---|---|---|
| `GCHandle.Alloc(obj, GCHandleType.Pinned)` / `fixed` statement | stop the GC moving an object while native code holds its address ("pin a moveable variable") | **N/A: the GC never moves.** AssemblyScript's runtime is "an incremental Tri-Color Mark & Sweep garbage collector" (`std/assembly/rt/itcms.ts:1`) — non-moving, so a guest address stays valid. The `fixed` statement's whole job is absent. |
| `[MarshalAs(UnmanagedType.LPStr)]`, `ByValTStr`, `BStr` | convert managed strings to native char layouts | **N/A: there is no string type at the boundary.** A string is a managed object; the guest encodes bytes itself (`String.UTF8.encode`, `tension-framework/assembly/io.ts:122-123`) and passes `(ptr,len)`. There is no marshaller to configure. |
| `[DllImport]` | declare an unmanaged entry point and generate a marshalling stub | **replaced by `@external("module","name")`**, which declares the import with *no* stub: the signature at the wasm level is exactly the declared parameter types (measured, §2.4). |
| non-blittable types / `Marshal.PtrToStructure` | convert between managed and native representations | **N/A: everything at the boundary is blittable.** "Blittable types … don't require conversion when they're passed between managed and unmanaged code"; the tree's 33 wire records are all scalars (`docs/interop-scope.md` §5) |
| COM interop | — | N/A: no COM in WASM. |
| `Marshal.GetLastWin32Error`, calling conventions | — | N/A: one calling convention, no errno channel; the ABI returns negative errno values instead (`tension_adapter.h`) |

---

## 2. TensionScript status, measured

### 2.1 Field access: the load-bearing measurement

**Write and read, one module, no module boundary.**

```ts
@unmanaged class Rec { a: i32 = 0; b: f32 = 0; c: f64 = 0; }
export function readB(p: Rec): f32 { return p.b; }
export function writeB(p: Rec, v: f32): void { p.b = v; }
```

At `--target release` **with no `--optimizeLevel`** — which is what the tree
actually builds with (§2.1.2):

```wat
(func $fieldaccess/readB (param $0 i32) (result f32)
  local.get $0
  call $fieldaccess/Rec#get:b        ;; ← a call
  return)
(func $fieldaccess/writeB (param $0 i32) (param $1 f32)
  local.get $0
  local.get $1
  call $fieldaccess/Rec#set:b        ;; ← a call
)
```

The accessor bodies are three instructions
(`local.get $0; f32.load offset=4`), so the call is pure overhead.

**The ladder.** Same source, same target, varying only `--optimizeLevel`:

| `--optimizeLevel` | accessor call sites | wasm bytes |
|---|---|---|
| 0 (the tree's effective level) | **7** | 335 |
| 1 | **0** | 230 |
| 2 | **0** | 204 |
| 3 | **0** | 204 |

At `-O1` and above the accessor functions are **not emitted at all**, and:

```wat
(func $fieldaccess/readB (param $0 i32) (result f32)
  local.get $0
  f32.load offset=4 )                 ;; 2 instructions
(func $fieldaccess/writeB (param $0 i32) (param $1 f32)
  local.get $0
  local.get $1
  f32.store offset=4 )                ;; 3 instructions
```

against the hand-rolled baseline:

```wat
(func $fieldaccess/readRaw (param $0 i32) (result f32)
  local.get $0
  i32.const 4
  i32.add
  f32.load )                          ;; 4 instructions
```

**Reads and writes behave identically** — no asymmetry. `changetype<Rec>(ptr).b`
emits the same two/three instructions as `p.b` (measured, both forms).

#### 2.1.2 Why the tree ships the call: it never sets an optimization level

`--target release` selects a configuration target; it does **not** enable
optimization. The CLI's own help pairs them: "Make a release build
`-O --noAssert`". Measured: `--target release` alone reproduces
`--optimizeLevel 0` exactly (335 bytes, 7 call sites).

The tree's build configuration sets **no** `optimizeLevel`:

- generated asconfig — `target: "release"`, `runtime: "incremental"`, memory
  flags, `exportStart` — and nothing else (`tension-framework/build.sh`
  template, `build/session.asconfig.json`);
- the framework's own build: `tensionscript index.ts -o build/index.wasm
  --runtime incremental --target release` (`tension-framework/package.json:9`);
- every example inherits the asconfig (`examples/ogre/bouncing-bodies/package.json:8`).

**Correction to the record.** The struct phase's Finding 2 ("15 inline stores
became 15 accessor calls, +161 bytes") is true **of the tree as configured** and
false as a property of the language. The probe was compiled with
`--target release` and no `-O`, matching the tree. At `-O3` the same probe emits
**zero** accessor calls and **zero** accessor functions, and turns the stores
back into inline `f32.store offset=N`.

Measured end to end: `tests/guest-open.ts`, a real session guest, compiled at
`-O0` and `-O3` and run on the real host:

| build | wasm bytes | run |
|---|---|---|
| `-O0 --noAssert` | 13 682 | `OK`, exit 0 |
| `-O0` (asserts on) | 15 247 | `OK`, exit 0 |
| `-O3 --noAssert` | 8 889 | `OK`, exit 0 |
| `-O3` (asserts on) | 10 352 | `OK`, exit 0 |

**Not measured:** the OGRE path at `-O3`. The four OGRE fixtures were not re-run
(this pass was told not to); so "the tree can move to `-O3`" is verified for the
session runtime only, and is an open risk for the OGRE adapter path.

### 2.2 `T[N]` and friends: the exact refusals

| form | result | site |
|---|---|---|
| `data: f32[4]` | `TS1005: ']' expected`, caret on `[` | `src/parser.ts:740-752` requires `]` immediately after `[` |
| `data: StaticArray<f32, 4>` | `TS1110: Type expected`, caret on the `4` | arity-1 class (`std/assembly/staticarray.ts:13`) |
| `data: [f32, f32]` | `TS1110: Type expected`, caret on the comma | tuple types behind `Feature.MultiValue` (`src/parser.ts:613`), and the CLI refuses the feature name |

### 2.3 Is there a sized view over raw memory?

**Nothing sound exists.** `StaticArray<T>` is the only type with an indexer and
a `.length`, and its length is the **allocator's block size**:

```ts
get length(): i32 {
  return changetype<OBJECT>(changetype<usize>(this) - TOTAL_OVERHEAD).rtSize >>> alignof<T>();
}
```

(`std/assembly/staticarray.ts:60-62`.) Measured on the real host:

| backing | `changetype<StaticArray<f32>>(ptr).length` | expected |
|---|---|---|
| `heap.alloc(16)` | **7** | 4 |
| `heap.alloc(64)` | **19** | 16 |
| `new StaticArray<f32>(4)` | 4 | 4 |

The indexer is bounds-checked against that number, so the check is not merely
useless — it is *wrong in both directions* (passes out-of-range reads, and its
bound has nothing to do with the array). The checked read compiles to inline
arithmetic plus a header load and an abort path; the **unchecked** read is
expressible and correct:

```ts
unchecked(v[2])            // read: compiles to inline arithmetic, no check
unchecked(v)[3] = 7.25     // write: compiles; measured raw+12 == 7.25
unchecked(v[3]) = 7.25     // TS2540 — not a valid assignable target
```

So a guest *can* index raw memory correctly today, but only by defeating the
bounds check, and `.length` cannot be trusted. There is no `(ptr,len)` type whose
`.length` is the caller's length.

**`Array<T>` and `TypedArray` are not candidates**: both require a real managed
object (`ArrayBufferView` holds `buffer`, `dataStart`, `byteLength`,
`std/assembly/arraybuffer.ts:8-13`), so a view over an arena slot has no header
to point at.

**Nothing else in std declares a length.** `memory.data<T>` returns `usize`;
`memory.compare/copy/fill` take explicit lengths. A `Span` does not exist.

### 2.4 Does `(ptr,len)` cross the ABI cleanly?

**Yes — as two scalars. As one value, no.**

Measured import signatures (the wasm-level types, `-O3`):

| declaration | emitted import |
|---|---|
| `declare function twoScalars(ptr: usize, len: usize): i32` | `(param i32 i32)` |
| `structParam(p: Pair)` where `@unmanaged class Pair { ptr: usize; len: usize }` | **`(param i32)`** — a pointer |
| `classParam(r: Rec)` | `(param i32)` — a reference |
| `staticArrayParam(s: StaticArray<f32>)` | `(param i32)` — a reference |

So a struct does **not** cross by value; the host receives a pointer and would
have to `guest_read` the two words. The ABI's own idiom is the opposite — two
separate scalars, everywhere:

- `int32_t (*guest_read)(void *user, uint32_t ptr, void *dst, uint32_t len)`
  (`tension_adapter.h:184`)
- `guest_write(..., uint32_t ptr, ..., uint32_t len, uint32_t dst_capacity)`
  (`:326-331`)
- `log(void *user, int32_t level, const char *msg, uint32_t len)` (`:232`)
- the `tension_core_api` is "Frozen at ABI version 2", with
  `TENSION_ADAPTER_ABI_VERSION 3` (`:17`, `:78`)

**Consequence:** a Span-equivalent needs **no ABI change**. The pair already
crosses; what is missing is a *guest-side type* that gives the pair a `.length`
and an indexer. That is std work, not ABI work, and it moves no hash (§4).

### 2.5 Explicit layout: a silent hazard

`[FieldOffset]`'s TensionScript attempt compiles and is **ignored**:

```ts
@unmanaged class A { pad: i32 = 0; @fieldOffset(16) x: i32 = 0; }
@unmanaged class B { pad: i32 = 0; x: i32 = 0; }
```

Measured: `offsetof<A>("x") = 4`, `offsetof<B>("x") = 4`, `offsetof<A>() = 8` —
identical, with **no error and no warning**. A developer arriving from C# writes
`[FieldOffset(16)]`, gets declaration-order layout, and finds out when the host
reads the wrong bytes. Recorded as a hazard; the scoping does not propose a fix.

---

## 3. The dependency graph

Partial order — each edge is measured or cited.

```
(0) build config: optimizeLevel ≥ 1        ← measured: removes all accessor calls;
    │                                          independent of everything below
    ├── makes field access C#-gold today        (§2.1)
    │
(1) T[N]  (compiler: parser + layout + codegen)
    │  depends on: nothing in (0) — its element access would be a load with an
    │  immediate, which (0) already inlines. Measured: field access inlines at
    │  -O1+, and an array field's access is the same shape (base + i*size).
    │  does NOT depend on (2): the input host's `keys_held[8]` is a flat block,
    │  not a view over caller-supplied memory (tension-input/src/input.h:46).
    ↓
(2) Span-equivalent (std type over (ptr,len))
    │  depends on: nothing. The ABI already carries the pair as two scalars
    │  (§2.4), so the type is guest-side and can be written today.
    │  does NOT depend on (1): a view needs no inline array field.
    ↓
(3) Follow-up G (compiler accessor inlining)
       downgraded by (0): the inliner already does it at -O1+. G is not a
       prerequisite for anything; it would only matter if the tree insisted on
       building at -O0 and wanted inline access anyway.
```

**The layout hash** does not appear in this graph. It folds Rust constants for
the arena's records (`arena.rs:1030-1104`); the guest's own declarations are
never an input (verified in `docs/interop-scope-addendum-2.md`, Item 1: the
generator is a pure function of `session.json`, regenerated byte-identically).
The input capability's records — the only host records with array fields — are
**not** in the fold at all (`grep keys_held|axes tension-core/src/session/arena.rs`
→ no hits; the input DSO checks its own structs with `static_assert`,
`tension-input/src/input.h:58-60`).

**If a future `T[N]` or Span field is used in a record the host also reads**,
then the layout has to be announced to the host, and the hash is the mechanism.
That is the extension shape, not a current cost (§4.2).

---

## 4. "C#-gold ergonomics + hash verification"

### 4.1 Where the goal is already met, and where it is stronger than C#

| dimension | C# | this tree |
|---|---|---|
| declare once, layout follows | `[StructLayout(Sequential)]` | `@unmanaged` declaration order (default) |
| size | `sizeof` (unsafe) / `Marshal.SizeOf` | `offsetof<T>()` (compile-time) |
| field offset | `Marshal.OffsetOf` (runtime) | `offsetof<T>("f")` (compile-time) |
| copy | `Buffer.MemoryCopy` | `memory.copy`; `COPY_STRUCT<T>` for the struct case |
| field access cost | JIT inlines `foo.data[i]` to `base + i*4` | **`-O1+` inlines to `base + offset`** (§2.1); at `-O0` it is a call |
| **declaration matches the native side** | **no check** | **`layout_hash` at session open + 135 compile-time `offsetof` checks** |

The last row is the dimension where the architect's goal is **stronger than
C#**. Evidence for the C# side: none of the five marshalling/layout pages
fetched (`StructLayoutAttribute`, `StructLayout` remarks, `MarshalAs`,
`FieldOffset`, blittable types, type marshalling) describes any step that
compares the managed declaration against the native header. The documented
mechanism is the opposite: the developer specifies the layout
("if you want to pass the type to unmanaged code, you can use the
`StructLayoutAttribute` to control the unmanaged layout of the type"), and the
marshaller applies it. `Unsafe.As` is explicit about the ethos: "It is the
caller's responsibility to ensure that the cast is legal."

*This is documentation-level evidence, not a proof of absence in the CLR — but it
is the strongest form available read-only, and it is consistent with how P/Invoke
failures present (silent corruption, not a load-time refusal).*

So the constraint is: **adopt C#'s ergonomics, keep the check C# does not have.**
The check is what makes "declare once" safe; dropping it to gain syntax would be
a regression against the goal, not progress toward it.

### 4.2 What the check would have to extend to

- **`T[N]` as a field of an `@unmanaged` record.** The record's offsets are
  already checked by `offsetof<T>("f")`; an array field adds one more offset
  (its base) plus a size relation (`N * sizeof(elem)`), both expressible as
  compile-time checks. **No host involvement, no hash move** — unless the record
  is one the host reads.
- **A Span field** (`struct { ptr: usize; len: usize }`) is two scalar words;
  the hash and the checks treat it as such. **No new mechanism.**
- **The extension shape, when the host *does* read the record:** the host's
  constant moves first (`arena.rs` + `session.json`), `layout_hash()` changes,
  `layout.ts` is regenerated, every guest is rebuilt. That is the 0.6.0a pattern.
  Today no such record needs an array (the input records are capability-local and
  outside the hash), so the shape is stated and not invoked.

### 4.3 The one claim the tree cannot make without moving the hash

None of the three features *requires* a hash move. The claim that would is:
"a guest may declare an arena record's inline array and the host will read it" —
because the host's own layout is the authority and it has no array fields today.
Reported; not proposed.

---

## 5. The version boundary — cost of each option

### Option A — 0.8.0 as "the interop release"

Contents: `sizeof` semantics, `store<T>` refusal, `T[N]`, Span-equivalent,
Follow-up G (or its removal, given §2.1).

| cost | detail |
|---|---|
| adapter rebuilds | every guest is rebuilt anyway on a compiler release; the two capabilities are C++ DSOs with no std dependency, so they rebuild only if the ABI moved — it does not (§2.4) |
| registry verifies | one TensionScript publish + one verify cycle; every consumer's `^0.7.1` → `^0.8.0` |
| consumer churn | 16 consumers, each `npm install` + rebuild; the `sizeof` semantics change is the breaking one, and it breaks std-internal loops first (`docs/interop-scope.md` §6.1 table) |
| interim cost | none — the C#-gold experience exists at the release |
| risk | the largest diff is the `sizeof` semantics change, bundled with the features; a regression in either is harder to attribute |

### Option B — incremental

`0.8.0` = `sizeof` + `store` refusal + `T[N]`; `0.9.0` = Span-equivalent;
codegen whenever.

| cost | detail |
|---|---|
| adapter rebuilds | two rounds instead of one |
| registry verifies | two publishes, two verify cycles |
| consumer churn | two transitions |
| interim cost | the Span-equivalent is absent between the releases; consumers keep hand-rolling `(ptr,len)` — which is exactly what the ABI already does, so the interim is the status quo rather than a regression |
| risk | each release is smaller and attributable |

**What would make A right:** if `T[N]` and the Span type are designed against one
layout rule, shipping them apart means the second release re-opens the first's
semantics — and `sizeof` semantics is already the phase that must not be split.

**What would make B right:** if the Span type needs its own design cycle (it is
a new std type with an ABI-adjacent story), bundling it forces the `sizeof`
release to wait on it.

**A third path neither option names, measured here:** the `optimizeLevel` change
(§2.1.2) is a **build-configuration** change, needs no release of anything, and
delivers the "field access is free" half of the goal immediately. It is
orthogonal to both options.

---

## 6. Design questions, answered

### 6.1 Is C#-gold achievable on the current compiler? Is there a hard floor?

**Achievable, and the floor is a flag, not an architecture limit.** The compiler
already generates an accessor whose body is the ideal two/three instructions;
the only question is whether it is inlined, and Binaryen's inliner does that at
`--optimizeLevel 1` with no compiler change (§2.1). At `-O0` the call is real,
which is a build-configuration choice the tree makes by omission.

What is **not** available on the current compiler is the *surface*: `T[N]`
(parser + layout + codegen) and a sized view type. Those are features, not
codegen limits, and neither is blocked by the accessor question.

The one place a floor could hide: **checked** indexing. `StaticArray`'s bound is
read from the allocator header, so a check costs a load plus an abort path. A
Span-equivalent with its own `len` would replace that with one load from the
view — still a check, but the correct one. That is a design choice in the view
type, not a compiler limit.

### 6.2 What is the Span-equivalent, as a design constraint?

Not a design, a shape with tradeoffs. Measured facts that constrain it:

- `(ptr,len)` already crosses the ABI as two scalars (§2.4), so the type needs no
  ABI support and moves no hash.
- A struct parameter crosses as a **pointer**, so passing the pair as one value
  would make the host `guest_read` two words — worse than two scalars.
- `StaticArray` cannot be repurposed: its length is the allocation's (§2.3), and
  a view over an arena slot has no allocation header.
- `Span<T>` in C# is a **stack-only `ref struct`** — it cannot be a field in a
  reference type or cross `await`. A TensionScript equivalent has no such
  restriction to inherit (there is no `ref struct`), but also no stack-only
  enforcement; whether it should be `@unmanaged` (so it can be a field, 8 bytes)
  or a value type is the design's call.

The three candidate shapes, with their measured consequences:

1. **`@unmanaged class Span<T> { ptr: usize; len: usize }`** — 8-byte layout, can
   be a field of a wire record, no hash impact unless the host reads it. Its
   indexer would be a method; whether it inlines is **not measured** — the type
   does not exist — but the inliner that removes field accessors at `-O1+`
   (§2.1) is the same one that inlines `StaticArray`'s `__uget` (measured:
   `unchecked(s[i])` is inline arithmetic at `-O3`).
2. **A pair of scalars at each call site** — today's ABI, zero new surface, no
   `.length`, no indexer: the status quo.
3. **A language type** — the only option that could enforce "stack-only" like
   C#'s `ref struct`, and the only one needing a compiler release.

### 6.3 `T[N]` semantics, against the C structs the tree needs

Confirmed from the arrays scoping, with the C records as the test:

- `uint32_t keys_held[8]` at offset 16, next field at 48 → **32 contiguous
  bytes, no interior padding** (`tension-input/src/input.h:46`,
  `tension-input/include/tension_input.h:142-144`).
- `float axes[6]` at 16, next field at 40 → **24 contiguous bytes**
  (`input.h:69`, `tension_input.h:175-176`).

So the rule is `N * sizeof(elem)`, element alignment, `offsetof<T>("f")` at the
first element, and the record's size grows by the whole extent. Both records have
literal bounds, so the array's length is a compile-time constant at every use —
which is the cheapest case for codegen (the index arithmetic folds exactly as
`unchecked` does today).

### 6.4 What is explicitly not part of the goal

- **`[MarshalAs]` strings** — no string type at the boundary; the guest encodes
  bytes (`io.ts:122-123`).
- **`GCHandle` pinning / `fixed`** — the GC is non-moving (`itcms.ts:1`), so
  addresses are stable; pinning solves a problem that does not occur.
- **`DllImport` stubs** — `@external` is the mechanism, and it generates no stub
  (measured: the import's signature is the declared types).
- **COM interop** — not present in WASM.
- **Non-blittable types / `Marshal.PtrToStructure`** — every wire record is
  scalars; there is no marshaller to configure.

### 6.5 What forces a "no"

1. **A codegen floor that makes field access permanently non-inline** — measured
   *not* to exist: `-O1` inlines it (§2.1). If a future compiler regressed this,
   the goal's cheapest half would need Follow-up G back.
2. **A Span-equivalent that cannot cross the ABI without moving the hash** —
   measured *not* to be the case: the ABI already carries `(ptr,len)` as scalars
   (§2.4), and the hash folds host constants only.
3. **A `T[N]` layout rule that conflicts with the generic-parameter system** —
   a real risk: `N` must be a literal or a compile-time constant, and a generic
   `T[N]` with `N` a type parameter is the case the parser's `Type` grammar has
   no production for. The arrays scoping already put generic size out of scope;
   this is why.
4. **A version boundary too costly to absorb** — the `sizeof` semantics change
   is the expensive one, and it is already committed to 0.8.0 independently of
   this goal (§5).

---

## 7. Recommendation

**The C#-gold goal is achievable, and cheaper than the phase order assumed.**
Three findings support that, in order of leverage:

1. **Do the build-configuration change first.** Adding `"optimizeLevel": 3` (and
   considering `"noAssert": true` — the CLI's help names `-O --noAssert` as
   "a release build") to the generated asconfig removes every accessor call, makes
   field access two instructions instead of four, and shrinks a real session
   guest from 13 682 to 8 889 bytes (`-O0`/`-O3` with `--noAssert` on both
   sides; with asserts on it is 15 247 to 10 352). No compiler change, no
   release, no hash
   move. **Verified for the session runtime only** (`guest-open` at `-O0`,
   `-O3`, `-O3 --noAssert`, all `OK` on the real host); the OGRE path at `-O3`
   is unverified and is the first thing to test.
2. **Then `T[N]`, as already scoped for 0.8.0.** It is the only missing piece of
   the *declaration* surface, and its layout rule is already pinned by two real
   C records. It carries no hash risk while it stays guest-side.
3. **The Span-equivalent is std work, not ABI work** — the boundary already
   passes `(ptr,len)` as scalars. It can ship on a package bump, before or after
   `T[N]`, and it does not depend on it.

**On the 0.8.0 question:** the measurements do not force the choice, but they
change its content. Option A's premise — that the C#-gold experience arrives with
the release — is weakened, because the *access-cost* half arrives with the build
flag instead. What remains for 0.8.0 is the surface (`T[N]`) and the semantics
(`sizeof`, `store<T>`), with the Span type free to follow either way.

**What would make this a "defer":** if enabling `-O3` tree-wide breaks the OGRE
path. That is the one untested dependency in the recommendation.

**What would make it a "no":** none of the four conditions in §6.5 holds today.

---

## 8. The `optimizeLevel` gate — measured, and the flag shipped

§2.1 found the access-cost half of the C#-gold goal is a build flag. The flag
was gated on three measurements before it was set; all three are green at
`-O3`.

### 8.1 Gate 1 — the four OGRE fixtures at `-O3` (real backend)

Compiled with the canonical compiler at `--optimizeLevel 3`, run on
`tension-core/target/debug` with `--runtime incremental`, the OGRE DSO, and
`TENSION_OGRE_HEADLESS=1` (NULL render system):

| fixture | `-O0` (the record) | `-O3` | verdict |
|---|---|---|---|
| `guest-motion` | 5/5 | **5/5** | pass |
| `guest-skinning` | 6/6 | **6/6** | pass |
| `guest-angular` | 8/8 | **8/8** | pass |
| `guest-physics` | 9/9 | **9/9** | pass |

Two numeric values moved in the tenth significant digit — `guest-angular` #5
`102.86244027957246` → `102.86244027948969` deg, #6 `38.99758472081325` →
`38.99758469322796` deg — consistent with FP reassociation under `-O3`. Every
assertion still passes; the roller's rest position and the contact-only bound are
byte-identical. No fixture regressed.

### 8.2 Gate 2 — the tree's examples at `-O3` (real backend)

Fifteen examples exist (twelve "adopter" and "non-adopter" in the dispatch's
split, plus `bouncing-ball`, `async-io`, `solver/*`). Each was compiled with its
own build arguments plus `--optimizeLevel 3` and run with
`scripts/run-example.mjs --no-build` on the real host.

| example | exit | result |
|---|---|---|
| `io` | 0 | pass — `You said: hello from the terminal` |
| `log` | 0 | pass — every level, unicode line intact |
| `audio` | 0 | pass — `audio_shutdown() -> 0` |
| `async-io` | 0 | pass — `no task left to resume: true` |
| `res` | 0 | pass — decompression pattern checks ok |
| `solver/wasm` | 0 | pass — `y1` matches the analytic value |
| `solver/world` | 0 | pass — `\|err\| = 6.6e-11` |
| `solver/collision` | 0 | pass — 85 trajectory lines |
| `ogre/hello-triangle` | 0 | pass — `submitted 1 object` |
| `ogre/hello-mesh` | 0 | pass — `submitted 1 object` |
| `ogre/bouncing-bodies` | 0 | pass — settles, `kinetic energy 0.0` |
| `ogre/animated-character` | 0 | pass — `4 characters, one mesh, four skins, three clips` |
| `ai` | 0 | pass against the stub backend (no model present) |
| `ogre/input-camera` | 1 | **fail — pre-existing, not `-O3`**: the input DSO was built for adapter ABI 2 and the host is ABI 3 (`was built against adapter ABI 2; this build is 3`). Reproduced identically with an `-O0` artifact: it fails at adapter load, before any guest code runs. |
| `ogre/bouncing-ball` | 1 | **fail — pre-existing, not `-O3`**: `AS105: Module requires at least '133' pages of initial memory`, the documented page gate. Reproduced with **no** `--optimizeLevel` at all. |

**`bouncing-bodies` output varies between identical builds.** Two `-O0` runs of
the same artifact gave `asleep 57/64` and `59/64` (46.76 vs 48.34 contacts per
frame); two `-O3` runs gave 273 and 262 simulated frames. The demo stops on a
wall-clock budget and reports what it reached, so a cross-build difference in its
summary is **not attributable to the flag** — measured by running the *same*
artifact twice.

**Highest level at which the whole tree's examples pass: `-O3`** (the two
failures are environment/prerequisite failures that reproduce at `-O0`).

### 8.3 Gate 3 — the probe ladder, completed

`/tmp/surfprobe/fieldaccess.ts`, `--target release`, runtime incremental:

| `--optimizeLevel` | accessor call sites | wasm bytes |
|---|---|---|
| 0 | 7 | 335 |
| 1 | 0 | 230 |
| 2 | 0 | 204 |
| **3** | **0** | **204** |

`-O3` is not "smaller but buggy": it is the same size as `-O2` and it is the
level the fixtures and examples above were run at.

### 8.4 The flag, and where it was set

`-O3`, chosen on the three gates. The sites — this is the positive answer to the
§2.1.2 negative ("not in the generated asconfig…"):

| site | file:line | change |
|---|---|---|
| the asconfig generator | `tension-framework/build.sh:148-170` | `"optimizeLevel": 3` in `asconfig_doc["options"]`; every `--config` build inherits it |
| the framework's own build | `tension-framework/package.json:9` | `--optimizeLevel 3` appended |
| examples that bypass the asconfig | `examples/{audio,io,log,res}/package.json:8`, `examples/solver/{collision,wasm,world}/package.json:8` | `--optimizeLevel 3` appended |

Examples that build with `--config` (`ai`, `async-io`, `ogre/*`) need no edit:
the generated asconfig now carries the level, verified by byte-identity — the
four OGRE fixtures compiled *through the config* are sha256-identical to the same
sources compiled with an explicit `--optimizeLevel 3` (§8.5).

Not touched: the test runners (`tension-framework/tests/run.sh`,
`tension-ogre/tests/run.sh`). They pass `--config` for session fixtures and
explicit flags for plain ones; only the former inherits the level, and the plain
fixtures were not part of these gates. Turning it on there is a separate
measurement.

### 8.5 Verified after the change

- `tension-core layout-hash` → **786288195**, and `arena.rs:1678` reads
  `786_288_195`. `layout.ts` is byte-identical (the generator emits no
  optimization constant).
- `cargo test --test framework_layout` → **3/3**.
- The four OGRE fixtures, compiled **through the generated config** and re-run:
  5/5, 6/6, 8/8, 9/9 — and sha256-identical to the explicit `-O3` artifacts.
- `tests/guest-open.ts` through the config: 10 352 bytes, `OK`, exit 0.

**Size deltas** at the chosen level (`-O0` → `-O3`, same source, same args):

| example | `-O0` | `-O3` | smaller |
|---|---|---|---|
| `guest-open` (session guest, asserts on) | 15 247 | 10 352 | 32.1% |
| `guest-open` (session guest, `--noAssert`) | 13 682 | 8 889 | 35.0% |
| `ogre/bouncing-bodies` | 236 498 | 206 980 | 12.5% |
| `ogre/animated-character` | 236 318 | 208 804 | 11.6% |
| `ogre/hello-mesh` | 178 910 | 164 877 | 7.8% |
| `ogre/hello-triangle` | 177 138 | 163 519 | 7.7% |
| `ai` | 176 589 | 163 477 | 7.4% |
| `async-io` | 167 443 | 156 841 | 6.3% |
| `solver/wasm` | 286 059 | 16 036 | 94.4% |
| `solver/collision` | 287 951 | 17 541 | 93.9% |
| `io` | 147 018 | 9 871 | 93.3% |
| `log` | 146 970 | 10 204 | 93.1% |
| `audio` | 149 982 | 12 545 | 91.6% |
| `res` | 157 500 | 17 699 | 88.8% |
| `solver/world` | 158 788 | 19 163 | 87.9% |

The two populations differ by what they link: the examples that include a
capability's record catalogue and the async/task machine shrink 6-25%; the
console-sized ones (no session, small runtime surface) shrink ~90%.

### 8.6 The pre-merge items

**Item 1 — the size delta, reconciled.** Two percentages had been quoted for
the same guest with different flag pairs. Measured on this branch, four cells:

| configuration | bytes |
|---|---|
| `-O0`, asserts on | 15 247 |
| `-O0 --noAssert` | 13 682 |
| `-O3`, asserts on | 10 352 |
| `-O3 --noAssert` | 8 889 |

Like-for-like: **32.1%** with asserts on (15 247 → 10 352) and **35.0%** with
`--noAssert` (13 682 → 8 889). The earlier "24.4%" compared a `-O0 --noAssert`
build against a `-O3` build that still had asserts — a mismatched pair, now
replaced by the two rows above. (The 13 690 first recorded in §2.1.2 differs by
8 bytes from this branch's 13 682 because that measurement was taken on the
struct-phase branch, whose `SessionInfo` declaration is 144 bytes; this branch
is based on `main`, where it is still 128.)

**Item 2 — the AI example at `-O3` ran the stub backend, not llama.cpp.** The
built host has `tension_core::ai::stub::StubSession` and was compiled
`--no-default-features --features audio`; no `.gguf` exists on the machine.
Numbers from the `-O3` artifact (163 477 bytes, the `-O3` size) with
`TENSION_AI_TRACE=1`: **1 `class=10` (AI_READY), 1 `class=11` (AI_DONE),
0 `class=12` (AI_ERROR), exit 0** — the stub's coalesced shape, which is not the
per-chunk shape the real backend produces. **The real-llama.cpp gate at `-O3` is
not satisfied in this session** and cannot be: the weights are a 2.39 GB
download and the host lacks the `ai` feature. Recorded as a merge gate.

**Item 3 — the six async fixtures at `-O3`, run.** Compiled through the config
(so at `-O3`) and run on the real host with `--post-test-events`:

| fixture | exit | output |
|---|---|---|
| `guest-push` | 0 | `PUSH parked…` / `PUSH resumed with 2` |
| `guest-flow` | 0 | `while+break 3`, `while+continue 9`, **`for+continue 9`**, `for+break 406`, `FLOW PASS` |
| `guest-drop` | 0 | `DROP woke with status -5 (-EIO)` |
| `guest-early` | 0 | `EARLY resumed with 6 (buffered before the park)` |
| `guest-chain` | 0 | `CHAIN outer: got 7` |
| `guest-sync` | 0 | `SYNC 12 synchronous awaits summed 504` |

`for+continue` is the assertion the `break`/`continue` bug once hung on; it
passes at `-O3`.

**Item 4 — `-O3` does not imply `--noAssert`.** They are separate options:
`noAssert` is its own field (`src/compiler.ts:249`, "If true, replaces
assertions with nops"), and nothing in the compiler couples it to
`optimizeLevel` (`grep optimizeLevel.*noAssert src/*.ts` → no hits). The `-O3`
shorthand sets `{optimizeLevel: 3, shrinkLevel: 0}` only. The tree sets no
`--noAssert` anywhere (`grep -rn noAssert` over the tree's json/sh/bat/mjs → no
hits), so **assertions remain** in every build this PR configures. Runtime
asserts are still emitted; only codegen for field access changed.

### 8.7 Bookkeeping

**(a) Follow-up K — the "bypass `--config`" pattern.** Seven examples set the
level in their own `package.json` because they build without `--config`; the
config-driven ones inherit and were verified byte-identical. A new example added
without `--config`, and without the flag, silently compiles at `-O0` and gets the
accessor-call shape back. Filed as K; not fixed in PR 27.

**(b) The 16 external consumers.** A consumer that builds through its own
`package.json` build line gets whatever that line says: consumers on `^0.7.1`
that pass `--config` against a regenerated asconfig inherit the level, and
consumers with a pinned `--optimizeLevel` do not. Nothing here changes a
consumer's build; that is a per-consumer decision when they bump.

**(c) The full cargo suite — run, at `-O3` fixtures: 37 suites, 519 passed, 0
failed** (the `fresh.txt` baseline is 519/0/37). The first attempts failed on
stale or missing fixtures in the gitignored `build/` directories (guests from
Oct 11 embedding a pre-0.6.0a layout hash, and `guest-async.wasm` absent);
after rebuilding them through the config the suite is green.

**(d) Console-sized examples — output compared, not just exit codes.** `io`,
`log` and `res` at `-O0` and `-O3` produce **byte-identical** output: `io`'s
argument dump and `You said: hello from the terminal`; `log`'s five levels
including `{"tick":1,…}` and `unicode survives the boundary: héllo wörld ✓`
with timestamps stripped; `res`'s 21-line volume walk including the
decompression pattern checks. "Smaller" was checked against "same output".

### 8.8 Still not measured

- **Real llama.cpp at `-O3`** — the merge gate in Item 2 above.
- **The 16 external consumers** (`^0.7.1` in their own repos) at `-O3`. They
  build with their own npm projects; not compiled here. The tree's own fifteen
  examples are the evidence available in this checkout.
- **The plain test fixtures** (`tension-framework/tests/run.sh`'s non-session
  ones) at `-O3`, for the reason in §8.4 — though the Rust suite above now
  exercises several of the same guests through the config.
- **Whether the CLR has a load-time check in some form the docs do not describe.**
  The documentation-level search found none (§4.1); a proof would need the
  runtime's source or a deliberate mismatch experiment on .NET.
- **`[InlineArray]`'s codegen on .NET.** The doc states the runtime replicates a
  single field; the JIT's indexing behaviour was not measured on .NET, so the C#
  side of the "free field access" claim rests on the documented model, not on a
  .NET measurement.

---

## 9. Follow-up J — `@fieldOffset` is silently ignored

**The measurement (from §2.5, restated as a filed item).**

```ts
@unmanaged class A { pad: i32 = 0; @fieldOffset(16) x: i32 = 0; }
@unmanaged class B { pad: i32 = 0; x: i32 = 0; }
```

`offsetof<A>("x") = 4`, `offsetof<B>("x") = 4`, `offsetof<A>() = 8` — identical.
The decorator compiles with **no error and no warning**, and the field keeps
declaration-order placement.

**The usage inventory (grepped, this pass).**

| where | hits | detail |
|---|---|---|
| the tree (`--include=*.ts --include=*.md`, excluding `node_modules` and `third_party`) | **0** real uses | the only matches are this document's own prose (§1.1, §2.5, §4.1, appendix G) |
| `third_party/assemblyscript/std` and `/src` | **0** | no decorator, no diagnostic, no parser branch |
| the canonical checkout (`~/work/as-inspect/assemblyscript/std`, `/src`) | **0** | same |
| `examples/` | **0** | — |

So nothing in the tree depends on it, and nothing tests it. The hazard is
prospective: a developer arriving from C# writes `[FieldOffset(16)]`, the
compiler accepts it, and the layout is declaration-order. The failure surfaces
when the host reads the wrong bytes — silent, which the pipeline notes name as
the worst failure mode.

**The shape of the bug:** `@fieldOffset` must either **work** or **refuse**
(error or warning). Silent ignore is worse than either, because it is the one
outcome that looks like success. Note the contrast with an *unknown* decorator,
which the compiler also accepts silently — so this is not specific to
`fieldOffset`; the decorator namespace has no validation at all.

**Filed as Follow-up J. Not fixed in this phase.** No fix is proposed here: the
choice between "implement explicit layout" (which would collide with the
declaration-order rule the 33 wire types and the layout hash depend on) and
"refuse the name" is a language decision, not a build one.

---

## Appendix — this pass's probes

Compiled with published `@acakar/tensionscript@0.7.1`; the canonical checkout's
`dist/asc.js` was used where noted. All runtime runs on
`tension-core/target/debug/tension-core`.

**A. Field-access ladder** (`fieldaccess.ts`, `--target release`, runtime
incremental):

```
optimizeLevel=0  accessor call sites=7  wasm=335
optimizeLevel=1  accessor call sites=0  wasm=230
optimizeLevel=2  accessor call sites=0  wasm=204
optimizeLevel=3  accessor call sites=0  wasm=204
```

`readB` at `-O3`: `local.get $0; f32.load offset=4`. `readRaw`:
`local.get; i32.const 4; i32.add; f32.load`.

**B. Converted framework writers at `-O3`** (`motioncheck/probe.ts`):
accessor call sites **0**, accessor functions emitted **0**; the stores are back
inline.

**C. Session guest at three settings** (`tests/guest-open.ts`, real host):

```
-O0           13690 bytes   OK
-O3 --noAssert 8889 bytes   OK
-O3            10352 bytes  OK
```

**D. Refusals:**

```
f32[4]                        TS1005 ']' expected  (1,31)
StaticArray<f32, 4>           TS1110 Type expected  (1,45)
[f32, f32]                    TS1110 Type expected  (1,28)
```

**E. Import signatures** (`abi.ts`, `-O3`):

```
two_scalars(usize,usize)      (param i32 i32)
structParam(Pair)             (param i32)
classParam(Rec)               (param i32)
staticArrayParam(StaticArray) (param i32)
```

**F. Raw-view length** (`viewlen.wasm`, real host):

```
16-byte block -> 7 (want 4)
64-byte block -> 19 (want 16)
real StaticArray<f32>(4) -> 4
unchecked(v[2]) = 42.5
after unchecked(v)[3]=7.25, raw+12 = 7.25
```

**G. Explicit-offset decorator ignored** (`dec2.ts`):
`offsetof<A>("x") = 4` with `@fieldOffset(16)`, identical to the undecorated
class; no error, no warning.

**H. The tree's build configuration:**

```
build/session.asconfig.json: runtime, target, importMemory, memoryBase,
initialMemory, maximumMemory, exportTable, exportStart   (no optimizeLevel)
tension-framework/package.json:9  ... --runtime incremental --target release
```
