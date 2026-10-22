# Interop 0.8.0 — implementation scoping (the bundle)

**Status:** scoping only. No source changed, no code, no plan, no PR.
**Base:** Tension `main` @ `31a6626` (PR 26 merged 2026-10-22T00:50:11Z); the
`-O3` figures are from PR 27's branch (`build/optimize-level` @ `1c663ed`, PR
27 still OPEN); TensionScript `0.7.1` in `third_party/assemblyscript` for
compile-output claims.
**Siblings:** `docs/interop-tn-scope.md` (PR 28), `docs/interop-surface-scope.md`
(PR 27's branch), `docs/interop-scope.md`, `docs/interop-scope-addendum.md`,
`docs/interop-scope-addendum-2.md`, `docs/interop-arrays-scope.md` (all on
`main` after PR 26). `docs/async-complete.md` unmodified.

**Method.** Compile-output claims use the published
`@yabgu_gm/tensionscript@0.7.1` with `--target release --runtime incremental`,
emitting WAT with `-t`. Source claims cite the tree's own
`third_party/assemblyscript`. Probes live in `/tmp/szprobe/`; none is in the
repo. Nothing in `third_party/` was written.

**What this document is not.** It does not re-measure what is already measured:
`sizeof` returning `byteSize`, the `store<T>` width, T[N]'s cost, and Span's
independence are cited from the struct and surface/tn scopes. It measures the
things those scopes did **not** pin: the collateral per site under the fix
shapes actually available, the store refusal's caller count, and the ordering.

---

## 0. The answer up front

**The bundle is coherent, and its cost is narrower than the struct phase's
collateral table implies — but only if the `sizeof` fix is scoped, and the
scoping choice is the whole risk.**

1. **The collateral table describes a `Type.byteSize` change, not a `sizeof`
   change.** `sizeof` and `store` both read `type.byteSize`
   (`builtins.ts:1243`, `:2577`), so changing `byteSize` for classes would move
   reference strides, store widths, load widths, `alignof`, and field layout
   together. A change **at `builtin_sizeof`** leaves all of that alone. These
   are different phases with different blast radii, and the table in
   `docs/interop-scope.md` §6.1 is the first one.
2. **The table is also incomplete.** It lists `array.ts:230,238`, `:214`, the
   four `staticarray.ts` loops, `map.ts:43-44`, `set.ts:41`, and
   `tests/compiler/class.ts:13`. Two sites of the same class are missing:
   **`array.ts:336`** (`shift`) and **`array.ts:361`** (`unshift`) use
   `sizeof<T>()` as an element-stride offset in `memory.copy`, with no
   `isManaged<T>()` guard. Measured: `shift` emits `i32.const 4; i32.add`.
3. **A `sizeof`-all-classes change is incoherent for containers.** Measured:
   `offsetof<StaticArray<u8>>()` = **0** and `offsetof<Array<u8>>()` = **16**,
   while `sizeof<...>()` = 4 for both. A `sizeof` returning layout size would
   make a loop stepping by `sizeof<StaticArray<T>>()` step zero bytes, and one
   stepping by `sizeof<Array<T>>()` step 16. That rules out the
   all-classes variant on its own terms.
4. **The tree is untouched by the collateral.** Measured: the tree has **no**
   `sizeof<Class>` use (its only `sizeof<` calls are `sizeof<usize>()` at
   `tension-framework/assembly/runtime/callbacks.ts:35` and
   `tension-framework/tests/guest-callbacks.ts:39,43`), **no** `Array<@unmanaged
   T>` or `StaticArray<@unmanaged T>`, and **no** `.concat(`/`.shift(`/
   `.unshift(` call. The affected std methods are not instantiated with a class
   element by the tree.
5. **The store refusal has zero callers in the tree.** Measured by distinct type
   argument: 105 `store<` sites, all scalars (`f64` 37, `f32` 36, `u32` 22,
   `u64` 8, `u16` 2). `store<Mat4f>(ptr, m)` compiles today and emits
   `i32.store` — one word. The refusal is a language-level correctness fix with
   no consumer cost, plus one std edit for `Array<@unmanaged T>` if such a
   guest ever exists.
6. **Recommendation: proceed with the bundle as 0.8.0** — `sizeof` as a
   `@unmanaged`-scoped builtin change, `store<T>` refused by a compile-time
   diagnostic, `T[N]` per `docs/interop-tn-scope.md`. The ordering has one real
   edge (T[N] layout before `sizeof` is correct for an array-bearing record) and
   no hard edges elsewhere. The architect decides when.

**The decisions since this section was written.** §10 records the two
architecture decisions — variant B (Decision 1) and the fix living at
`builtin_sizeof` rather than `Type.byteSize` (Decision 2) — which settle what §8
left open. §11 closes a gap: the scoping covered the `store<T>` refusal and was
silent on `load<T>`, which is broken on an `@unmanaged` T for the same reason and
has zero callers in the tree; it folds into the bundle as a fourth piece. §12
records the two open items. The bundle is therefore **four pieces**: `sizeof`
(B), the `store<T>` refusal, the `load<T>` refusal, and `T[N]`.

---

## 1. The `sizeof` collateral, re-verified per site (Item 1)

### 1.1 The two mechanisms, and why the distinction decides the phase

`sizeof` reads one property:

```ts
let type = ctx.typeArguments![0];
let byteSize = type.byteSize;                 // builtins.ts:1243
```

`byteSize` is `size + 7 >>> 3` (`types.ts:193-195`), and a class type is built
from `Usize` (`types.ts:74-76`, "also the base of class types"), so it is 4.
`store` reads the same property for both its width and its default alignment:

```ts
let immAlign = type.byteSize;                 // builtins.ts:2561
...
return module.store(type.byteSize, arg0, arg1, ...);   // builtins.ts:2577
```

Measured, on one source, in one module:

| expression | measured |
|---|---|
| `sizeof<Mat4f>()` (16 `f32` `@unmanaged`) | **4** |
| `offsetof<Mat4f>()` | **64** |
| `store<Mat4f>(ptr, m)` | compiles; emits `i32.store` (one word) |
| `sizeof<Array<u8>>()` / `offsetof<Array<u8>>()` | **4** / **16** |
| `sizeof<StaticArray<u8>>()` / `offsetof<StaticArray<u8>>()` | **4** / **0** |
| `sizeof<String>()` / `offsetof<String>()` | **4** / **0** |

So three implementation shapes exist, and they are not interchangeable:

- **(A) change `Type.byteSize` for class types** — moves everything that asks a
  class its size: `sizeof`, `store` width, `load` width, `store`'s default
  alignment (`:2561`), `alignof` (`:1264-1274`), and the class-layout loop
  (`resolver.ts:3677-3682`).
- **(B) change `builtin_sizeof` for `@unmanaged` classes only** — `sizeof` starts
  reporting `nextMemoryOffset`; `byteSize` is untouched, so `store`/`load`/
  `alignof`/layout are unchanged.
- **(C) change `builtin_sizeof` for all classes** — the container measurements in
  §1.1 make this incoherent (`StaticArray` layout 0, `Array` layout 16).

The struct phase's collateral table measures **(A)**. Its own §6.1 says so:
"A 'fix' that changes `byteSize` for class types changes the size of a
*reference* everywhere the compiler asks, not only at the two call sites the
phase cares about." This scoping reports the per-site effect for **(A)** and for
**(B)**, because the choice is the architect's and the cost differs.

### 1.2 The sites, one at a time

For each: what it does, what changes, the corrected form (described, not
written), and whether the change is mechanical (swap the count) or semantic (the
site assumed the reference width and needs a different idiom).

| site | what it does | under (A) | corrected form | class |
|---|---|---|---|---|
| `array.ts:214` | `push`, non-managed branch: `store<T>(this.dataStart + (oldLen << alignof<T>()), value)` | writes `byteSize` bytes of a value that is a reference when T is a class → layout-size store into a 4-byte slot. Under (B): unchanged width | for a reference element, store the reference width; for a record element, the named copy | **semantic** |
| `array.ts:230` | `concat`, `isManaged<T>()` branch: `offset += sizeof<T>()` over a 4-byte-stride array | stride becomes the element's layout size → the loop walks past the array | step by the reference width (`sizeof<usize>()` / `1 << alignof<T>()`) | **semantic** |
| `array.ts:238` | same loop, the second array | same | same | **semantic** |
| `array.ts:336` | `shift`: `memory.copy(base, base + sizeof<T>(), lastIndex << alignof<T>())` | the source moves a whole record instead of one element → corruption. **No `isManaged` guard**; fires for every class T | `base + (1 << alignof<T>())` | **semantic** |
| `array.ts:361` | `unshift`: `memory.copy(ptr + sizeof<T>(), ptr, ...)` | the destination moves a whole record → corruption. **No guard** | `ptr + (1 << alignof<T>())` | **semantic** |
| `staticarray.ts:191` | `concat`, `isManaged<T>()` branch, first source | stride becomes layout size | reference width | **semantic** |
| `staticarray.ts:198` | same, second source | same | same | **semantic** |
| `staticarray.ts:214` | same, `out instanceof StaticArray<T>` branch, first source | same | same | **semantic** |
| `staticarray.ts:221` | same, second source | same | same | **semantic** |
| `map.ts:43-44` | `ENTRY_ALIGN<K,V>`: `sizeof<K>()`/`sizeof<V>()` as an alignment hint | a class K/V raises the entry alignment → stride/padding changes | use `alignof` or the reference width for a reference K/V | **mechanical** (behaviour, not correctness) |
| `set.ts:41` | `ENTRY_ALIGN<T>`: same shape | same | same | **mechanical** |
| `tests/compiler/class.ts:13` | `assert(sizeof<Animal<f64>>() == sizeof<usize>())` | the baseline moves | re-baseline (under (B): `Animal` is managed, so unaffected) | **mechanical** |

**Two sites the earlier table did not list.** `array.ts:336` and `:361` are the
same hazard as the loops and are **unguarded**, so they fire for any class
element, not only in the `isManaged` branch. Measured on `Array<Mat4f>`:

```
$ tensionscript shift.ts   # a.shift(); a.unshift(m)
(func $~lib/array/Array<shift/Mat4f>#shift ...)
  i32.const 4
  i32.add            ;; base + sizeof<T>()
  ...
  i32.const 2
  i32.shl
  memory.copy
(func $~lib/array/Array<shift/Mat4f>#unshift ...)
  i32.const 4
  i32.add            ;; ptr + sizeof<T>()
  i32.const 2
  i32.shl
  memory.copy
```

Under (A), `sizeof<Mat4f>()` = 64 would make those offsets 64 instead of 4.

**One site checked and cleared.** `task-rt.ts:564,566` reads `sizeof<R>()` to
choose the async completion slot (`RECORD_PAYLOAD` 8 / `RECORD_F0` 16,
`task-rt.ts:117-119`). A class `R` cannot reach it: a reference-typed await
result is refused at `compiler.ts:8026-8032` (`"a reference-typed await
result"`). So `R` is always a value type and its `sizeof` is unaffected by (A)
or (B).

**The `map`/`set` heuristic is live, and bounded.** The tree does instantiate
`Map<string, Logger>` (`tension-framework/assembly/log.ts:44`). The hint is
floored at the pointer width —
`maxkv > sizeof<usize>() ? maxkv : sizeof<usize>()` (`map.ts:44`) — so under (A)
the alignment moves only for a class whose layout size exceeds 4. `Logger`'s
instance fields total one `string` reference (`log.ts:46`), so `maxkv` stays 4
and the entry alignment is unchanged in this instantiation. The site is a
behavioural risk, not a correctness one, exactly as `docs/interop-scope.md`
§6.1 labels it.

### 1.3 What each variant costs, stated as a count

| variant | std sites that change | semantic | mechanical | tree sites that change | test baselines |
|---|---|---|---|---|---|
| **(A)** `byteSize` | 11 (the table + `:336`, `:361`) | 8 (the two loops and the two `shift`/`unshift` offsets in both container classes) | 3 (`map`, `set`, `class.ts`) | 0 | 1 |
| **(B)** `builtin_sizeof`, `@unmanaged` only | 3–4 (`array.ts:336`, `:361`; `map`/`set` only for an `@unmanaged` K/V) | 2 (`shift`, `unshift`) | 1–2 | 0 | 0 |
| **(C)** `builtin_sizeof`, all classes | as (A) plus the container case | 8, and `StaticArray`'s loops step 0 | 3 | 0 | 1 |

Under (B) the guarded loops (`array.ts:230,238`; `staticarray.ts:191,198,214,221`)
are **not** affected: they run inside `isManaged<T>()`, which is false for an
`@unmanaged` class (`types.ts:346-352`), so an `@unmanaged` T never reaches them.
The two unguarded `shift`/`unshift` sites are.

**Instantiation status — measured, and the reason the count is latent, not
live.** A generic std method only carries a site's risk where it is
instantiated:

- the tree calls `.concat(`, `.shift(`, `.unshift(` **zero** times
  (`grep` over `tension-framework` and `examples`, excluding `node_modules`);
- the tree's `Array<...>` instantiations are `u8` (19), `string` (3), `f32` (3),
  `BoneTransform` (3), `u32` (2), `i32` (2), and one each of `ResEntry`,
  `Refusal`, `FixturePair`, `ArrayBuffer`. `BoneTransform`
  (`tension-framework/assembly/anim/key.ts:51`), `ResEntry`
  (`tension-framework/assembly/res.ts:70`), `Refusal`
  (`tension-framework/tests/guest-anim-parser.ts:76`) and `FixturePair`
  (`tension-framework/tests/anim-expectations.ts:58`) are **managed** classes —
  none is `@unmanaged`;
- the std array tests' `concat`/`shift`/`unshift` blocks use `Array<i32>`
  (`tests/compiler/std/array.ts:188-206`, `:263-287`), so the managed-element
  loop is not exercised there.

So the semantic sites are correct today and would be *wrong* only once a class
element reaches them. The tree does not do that; a future guest would. That is a
latent defect, not a live one, and it is why the corrected form matters more
than the count.

---

## 2. The `store<T>` refusal (Item 2)

### 2.1 Where the width is emitted

`builtin_store` (`src/builtins.ts:2514-2579`). The width and the default
alignment both come from `type.byteSize`:

```ts
let immAlign = type.byteSize;                          // :2561
...
return module.store(type.byteSize, arg0, arg1, inType.toRef(), immOffset, immAlign);  // :2577
```

Measured consequence: `store<Mat4f>(ptr, m)` compiles and emits

```wat
(func $probe/storeMat (param $0 i32) (param $1 i32)
  local.get $0
  local.get $1
  i32.store )
```

— one word, storing the reference. The value is not the record.

### 2.2 The refusal's shape

Three shapes are available, and the machinery for the first two already exists:

1. **A compile-time error at builtin evaluation** (the recommended shape). The
   builtin already refuses a non-memory type at `:2541` with
   `DiagnosticCode.Operation_0_cannot_be_applied_to_type_1` — code **203**
   (`src/diagnosticMessages.json:19`, `"Operation '{0}' cannot be applied to
   type '{1}'."`). The predicate is `Type.isUnmanaged` (`types.ts:356-359`), i.e.
   `classReference != null && hasDecorator(DecoratorFlags.Unmanaged)`; the
   neighbouring builtin `idof` already uses the same pattern
   (`builtins.ts:1370-1374`). The error fires per instantiation, so a guest that
   never writes `store<@unmanaged T>` never sees it.
2. **A trap at codegen** — rejected: it defers a statically known error to
   runtime, which is the opposite of the tree's discipline (compile-time
   `offsetof` checks, `wire.checkWireOffsets`).
3. **A new diagnostic** — possible, if the message names the fix
   (`COPY_STRUCT` / `memory.copy` of `offsetof<T>()`) rather than reuse 203.
   `Not_implemented_0` is **100** (`diagnosticMessages.json:2`).

**Which types to refuse.** `@unmanaged` only (the dispatch's shape): a managed
class `store` writes a reference and stays allowed, and a value type's `store`
is the memory operation it looks like. `Type.isUnmanaged` is the exact
predicate; `Type.isManaged` (`types.ts:346-352`) is its complement for classes.

### 2.3 The caller count

**The tree: zero.** Measured by distinct type argument over 105 `store<` sites:

| type argument | sites |
|---|---|
| `f64` | 37 |
| `f32` | 36 |
| `u32` | 22 |
| `u64` | 8 |
| `u16` | 2 |

No site names a class: a search for any `store<` whose argument is one of the
tree's `@unmanaged` types → none. The struct
phase's narrower claim ("no `store<` in bones/motion after item 4") holds and
generalises: the whole tree uses `store<scalar>` only.

**std: generic sites that bind T, only when instantiated with an `@unmanaged`
T.** The generic `store<T>` sites are `array.ts:134` (`__set`), `:214`
(`push`), `:343`/`:365` (`shift`/`unshift`), `staticarray.ts:98` (`__uset`),
`util/sort.ts` (many), `util/bytes.ts:49-50,104`. Measured: `Array<Mat4f>` and
`StaticArray<Mat4f>` **do** compile and instantiate those functions with
`T = Mat4f`, and the emitted bodies use `i32.store` (width 4).

So the refusal's cost is: `Array<@unmanaged T>` / `StaticArray<@unmanaged T>`
would stop compiling unless those std sites store the reference width
(`store<usize>`) instead. That is one std edit per site, and it is **semantic**
in name only: the element of an `Array<@unmanaged T>` *is* a reference, so
`store<usize>` is the operation meant. The tree never instantiates those
functions with an `@unmanaged` T (§1.3), so today the edit is a correctness
change with no live consumer.

**Statement the dispatch asked for:** the tree does not call `store<T>` on an
`@unmanaged` T anywhere. The refusal is a language-level correctness fix with no
consumer cost, and its only std consequence is the `Array<@unmanaged T>` path,
which the tree does not use.

---

## 3. T[N]'s dependency on `sizeof` (Item 3)

### 3.1 The edges

- **T[N] does not need the `sizeof` fix to lay out.** `offsetof<T>()` already
  returns the layout size — `contextualUsize(..., classReference.nextMemoryOffset,
  ...)` (`builtins.ts:1330`) — and the tree relies on that **128** times on
  `main` (52 in `ogre/wire.ts`, 76 in `runtime/wire.ts`). A field's
  `offsetof("field")` reads `property.memoryOffset` (`builtins.ts:1306-1321`).
  Both are independent of `sizeof`.
- **`sizeof` needs T[N] to be correct for an array-bearing record.** Under (B),
  `sizeof<Foo>` returns `nextMemoryOffset`, and that sum includes the array's
  extent only once the array type is laid out. So:
  **T[N] layout → `sizeof` correctness for a record containing T[N]**. For a
  record without an array, the `sizeof` fix is independent of T[N]. This is the
  incoherence the architecture decision names: without the fix, a guest can
  declare `arr: f32[4]` and still read `sizeof<Foo>() == 4`.
- **T[N]'s element size.** For scalar elements (`f32`, `u32`) the element size is
  `byteSize`, correct today. An `@unmanaged` **struct** element would need both
  the `sizeof` and `alignof` fixes (alignment today is `ctz(byteSize)` = 2 for a
  class, `builtins.ts:1264-1274`). `Struct[N]` is out by measurement
  (`docs/interop-tn-scope.md` §3.4), so this edge is latent, and it is the
  reason a future `Struct[N]` cannot ship on this release's semantics.
- **The layout engine change and the `sizeof` fix share one site.** The resolver
  loop that sums `nextMemoryOffset` (`resolver.ts:3677-3682`) is where the array
  case goes, and it is what `sizeof` reads through. They are the same code path,
  not two: the array case changes the sum, `sizeof` reports it. Declaration order
  is preserved (`resolver.ts:3640-3672` walks the prototype's members in
  declaration order), so the change is compatible with the ordering rule the
  hash's field tables assume.

### 3.2 What that means for the release

T[N] and `sizeof` are one release, not two, and the reason is internal
coherence rather than a version boundary: each is implementable alone, and the
pair is the only state in which a guest can both declare an inline array and
state its record's size. The order **within** the release is
T[N] layout → `sizeof` correctness for array records.

---

## 4. The ordering (Item 4)

### 4.1 The partial order, edge by edge

```
(1) sizeof fix  ──┐
                  ├──► 0.8.0 publish ──► framework bump ──► example rebuilds
(2) store refusal ┘
(3) T[N] layout ──► (1) for array-bearing records

  (1) ⟂ (2)   independent: different builtins (builtin_sizeof :1234,
              builtin_store :2514); neither reads the other's result.
  (1) ⟂ (3)   except (3) → (1) through nextMemoryOffset (§3.1).
  (2) ⟂ (3)   independent: the refusal is a diagnostic in builtin_store;
              T[N] changes the type graph and the layout loop.
  (1), (2), (3) ⟂ PR 27   the flag changes field-access economics, not
              semantics of sizeof/store/layout. T[N]'s *cost* is quoted at -O3
              (tn-scope §1); the *feature* does not depend on it.
```

Each edge, cited:

- **(1) ⟂ (2):** `sizeof` (`builtins.ts:1234-1253`) and `store`
  (`:2514-2579`) are separate builtins; the refusal adds a predicate to the
  second and touches nothing the first reads.
- **(3) → (1):** `builtin_offsetof` returns `nextMemoryOffset`
  (`builtins.ts:1330`); the array's extent enters that sum only via the layout
  loop (`resolver.ts:3677-3682`). Under (B), `sizeof` returns the same value.
- **(1) vs the tree:** the tree's `sizeof` uses are `sizeof<usize>()`
  (`callbacks.ts:35`, `guest-callbacks.ts:39,43`) — a pointer, unaffected under
  any variant.
- **(2) vs the tree:** zero class-typed `store<` sites (§2.3).
- **vs PR 27:** T[N]'s measured cost is the `-O3` column (2/7 read, 3/9 write,
  constant-index aliasing to named-field access — `docs/interop-tn-scope.md`
  §1). If PR 27 does not merge, the `-O0` column applies (11/12 for a constant
  index vs 14/17 for a named field, `tn-scope` §7.2) and the feature is
  *cheaper* relative to the tree than at `-O3` — the bundle is unaffected.

### 4.2 Is the order mechanical or does it have a semantic step?

Three steps are mechanical: the `T[N]` grammar and type kind, the `store`
refusal, the `sizeof` builtin branch. **The semantic step is the std rewrite of
the stride sites** (§1.2): `array.ts:230,238`, `:336`, `:361` and the four
`staticarray.ts` loops all have to stop treating `sizeof<T>()` as the element
stride and start using the reference width. Under (B) the four guarded loops and
the test baseline are untouched; the two unguarded `shift`/`unshift` sites
remain, and they are semantic.

So: **(B)'s semantic surface is two sites in `array.ts`; (A)'s is those two plus
four loops in `array.ts`/`staticarray.ts` plus a test re-baseline.**

### 4.3 Does the body of work need the tree's examples updated?

Measured: no example or framework source changes are required by any of the
three. The tree has no `sizeof<Class>`, no `Array<@unmanaged T>`, no
`store<Class>`, and no `concat`/`shift`/`unshift`. What changes for the tree is
the dependency line (15 example `package.json`s and
`tension-framework/package.json:31`, all `^0.7.1`) and a rebuild.

---

## 5. Release mechanics (Item 5)

### 5.1 What "one release" requires

| item | requirement | citation |
|---|---|---|
| version bump | TensionScript `0.7.1` → `0.8.0`; the `sizeof` semantics change is breaking | `third_party/assemblyscript/package.json:11`; `docs/interop-scope.md` §6.1 ("a minor release (`0.8.0`), not a patch") |
| std changes | the collateral in §1 (in-package: `std/assembly` ships with the compiler) | `std/assembly/array.ts`, `staticarray.ts`, `map.ts`, `set.ts` |
| test re-baseline | `tests/compiler/class.ts:13` under (A)/(C); none under (B) | `tests/compiler/class.ts:13` |
| framework dependency | `"@yabgu_gm/tensionscript": "^0.7.1"` → `^0.8.0` | `tension-framework/package.json:31` |
| example dependencies | the 15 example `package.json`s carry `^0.7.1` | `examples/*/package.json`, `examples/*/*/package.json` |
| example rebuild | every guest recompiled; `npm run build` per example | `examples/*/package.json` build scripts |
| external consumers | 16 consumers, each `npm install` + rebuild | `docs/async-complete.md` "Consumer state" |

### 5.2 The layout hash does not move

`layout_hash()` is a pure function of host constants (`arena.rs:1030-1104`,
field tables `:1110-1200`); guest declarations and guest `sizeof`/`offsetof`
sites are not inputs. Recorded value **786288195** (`arena.rs:1678`;
`layout.ts:16`). The input records with array fields are not in the fold
(`grep keys_held|axes arena.rs` → no hits; the only `[6]` is
`REGIONS[6].flags`, `arena.rs:1458`). `docs/interop-tn-scope.md` §5.3 reaches the
same conclusion for T[N]; the `sizeof` and `store` changes are guest-side
semantics and do not enter the fold.

**No hash move is implied. If anything in this phase moved it, it would be
reported before proposing; nothing does.**

### 5.3 The adapter ABI does not change

`TENSION_ADAPTER_ABI_VERSION 3` (`tension-core/include/tension_adapter.h:78`),
frozen API at version 2 (`:17`). No boundary signature is touched: `sizeof`,
`store`, and `T[N]` are all guest-side. No adapter rebuild is forced by the
bundle itself; the adapters rebuild only where a consumer's own `npm install`
runs.

---

## 6. The bundle's three-way fixture, shaped (Item 5, last bullet)

Shape: the mixed record from the T[N] scoping, whose correct layout is measured.

```ts
@unmanaged class WithArray {
  a: i32 = 0;      // 0
  arr: f32[4];     // 4 .. 19
  b: i32 = 0;      // 20
}                  // 24
```

Expected: `offsetof<WithArray>()` = **24**, `arr` at 4, `b` at 20,
`arr[2]` at **12** (`docs/interop-tn-scope.md` §4, measured on the manual
expansion).

| cell | state | what the cell asserts |
|---|---|---|
| **1. all three** | 0.8.0 | `sizeof<WithArray>()` = **24** = `offsetof`; `store<WithArray>(p, v)` is a **compile error**; `arr: f32[4]` parses; `arr[2]` at 12; `memory.copy` of 24 bytes round-trips (`memory.compare` = 0) |
| **2a. sizeof fixed, store not refused** | partial | `sizeof<WithArray>()` = 24, but `store<WithArray>(p, v)` still compiles and writes **4 bytes** (measured today: `i32.store`) — silent truncation, and the caller believes it copied the record |
| **2b. T[N] parses, layout wrong** | partial | the naive layout loop (`byteSize` as alignment, `resolver.ts:3677-3682`) gives `arr` at **16** and the record **36** bytes; `arr[2]` at 24, not 12 |
| **2c. store refused, sizeof not fixed** | partial | `store<WithArray>` is refused, but `sizeof<WithArray>()` = **4** (measured today for every class) — a guest sizing an allocation on `sizeof` under-allocates by 20 bytes |

Cells 2a and 2c are the two halves of the incoherence the decision names: each
feature alone is worse than neither, because it removes the symptom a caller
would notice. Cell 2b is the layout hazard `docs/interop-tn-scope.md` §3.3
derives from `resolver.ts:3677-3682`.

All four cells are **shaped and not executed**: cell 1 needs three compiler
changes that do not exist, 2a and 2c need the `sizeof`/`store` changes, and 2b
needs the grammar and the naive layout. What *is* measured is the substrate:
`sizeof<Mat4f>` = 4 vs `offsetof<Mat4f>` = 64 (§1.1), `store<Mat4f>` emitting
`i32.store` (§2.1), and the 24-byte manual layout (`docs/interop-tn-scope.md`
§4).

**Does the layout-engine change need its own fixture?** No. Cell 2b is the
layout engine's negative, and cell 1 is its positive; the T[N] fixture already
carries both, and a separate fixture would assert the same three numbers.

---

## 7. What forces a "no" (Item 7)

1. **A semantic collateral item with no obvious corrected form.** None: all
   eight semantic sites correct to the same rule — *the element stride is the
   reference width, not the element's size* (measured: `shift`/`unshift` emit
   `+4`). `docs/interop-scope.md` §6.2 puts it the same way: `sizeof` is the
   width of a `T`-typed value. The rule exists; the edits follow it.
2. **A `store` caller the tree cannot remove.** None: zero class-typed `store<`
   sites in the tree (§2.3). The std sites behind `Array<@unmanaged T>` are
   reachable only if a guest instantiates that, which the tree does not.
3. **A layout-engine change that conflicts with declaration order.** None: the
   array is fixed-size, so order is preserved and the sum grows
   (`resolver.ts:3640-3682`); the hash depends on the host's field tables, not
   on guest layout (§5.2).
4. **A `T[N]` layout the C headers cannot express.** Not the case: both records
   match to the byte under manual expansion (`docs/interop-tn-scope.md` §3.2).
5. **A container semantics that makes the all-classes `sizeof` incoherent.** This
   is a condition, and it fires: `offsetof<StaticArray<u8>>()` = **0** and
   `offsetof<Array<u8>>()` = **16** against a `sizeof` of 4 (§1.1). It forces the
   *scoping of the fix* (variant B), not a "no" on the bundle.

**The one thing that would force a "no" on the bundle as stated:** if the
architect requires `sizeof` to mean the same thing for managed and `@unmanaged`
classes. Variant (C) then becomes the only coherent option, and it makes
`sizeof<StaticArray<T>>()` = 0 — a loop stepping by it never advances. That is
not a reason to prefer (B); it is the reason the choice is explicit.

---

## 8. Recommendation

**Proceed with the bundle as 0.8.0**, with two implementation constraints that
the measurements, not taste, supply:

1. **The `sizeof` fix lives in `builtin_sizeof` and is scoped to `@unmanaged`
   classes** (`byteSize` untouched). This is the only variant whose semantics
   survive the container measurements (`StaticArray` layout 0, `Array` layout
   16), and it is the only one that leaves `store`'s width, `load`'s width,
   `alignof`, and field layout alone.
2. **The `store<T>` refusal is a compile-time error at builtin evaluation**,
   predicate `Type.isUnmanaged`, reusing diagnostic 203 (`Operation '{0}' cannot
   be applied to type '{1}'`) or a dedicated diagnostic that names the named
   copy. Not a trap.

The std rewrite that follows is the stride rule of §4.2 — under (B), two sites
(`array.ts:336`, `:361`) plus the `Array<@unmanaged T>` store sites. The test
re-baseline is not needed under (B) (`class.ts:13` pins a managed class).

**The order, and what waits on what:** `T[N]` layout before `sizeof` is correct
for an array-bearing record; everything else is independent; all three before
the publish. **The release is a compiler release and a std rewrite, with no hash
move and no adapter ABI change.** The tree's sources need no change; its
dependency lines and rebuilds do.

**What this scoping does not decide:** whether to accept the language split
implied by (B) — `sizeof<@unmanaged T>` reporting layout while
`sizeof<managed T>` reports a reference width. `docs/interop-scope.md` §6.1
names it as a language-design decision. The measurement says (B) is the only
variant that does not break `StaticArray`'s own loops; it does not settle
whether the split is wanted.

*Decided since: §10.1 accepts the split. The paragraph above is kept as the
state the scoping reached, not as a live question.*

**Migration for the 16 external consumers is a Docs dependency**, not this
scoping's deliverable: a 0.8.0 guide stating the `sizeof` semantics change, the
`store<T>` refusal, and the `T[N]` form. The precedent is
`docs/async-complete.md`'s "A consumer table is evidence, not a claim": the
`^0.6.0`/`^0.6.1` drift was staged by `git add -A` and had to be repaired in
`5746baf`. The 0.8.0 bump is staged by name, per consumer, and the guide is
written before the publish.

---

## 9. What could not be measured read-only

- **The `sizeof` fix itself** — no compiler change was made; every "under (B)"
  statement is derived from `builtins.ts:1243` and `types.ts:193-201`, not
  compiled.
- **The corrected std forms** — described, not written, and not compiled against
  a patched compiler.
- **The `store` refusal's diagnostic** — the code and predicate are cited; the
  message text is not chosen.
- **Whether every TensionScript test instantiates the affected generics with a
  class element** — **resolved, §12.1**: enumerated by grep, 9 class-element
  instantiations, all managed, none exercising `concat`/`shift`/`unshift`. The
  whole suite was still not run against a patched compiler.
- **`Array<@unmanaged T>` after the `load`/`store` refusals** — the spelling
  change is described (§12.2), not compiled: the refusals do not exist.
- **The framework build at 0.8.0** — it needs the new compiler; not available.
- **The 16 external consumers at 0.8.0** — not run.
- **Cell 1 of the bundle fixture** — needs all four changes.
- **The `load<T>` refusal's diagnostic** — the site and predicate are cited
  (§11.1, §11.3); the message text is not chosen.
- **The `-O3` figures in the T[N] cost** — from PR 27's branch; PR 27 is not
  merged (see `docs/interop-tn-scope.md`, "Conditional on PR 27").

---

## 10. Architecture decisions

These settle what §8 left open. They do not change any measurement above; they
choose among the variants §1 measured.

### 10.1 Decision 1 — variant B

**`sizeof<@unmanaged T>` returns the layout size (the sum of fields with their
alignment). `sizeof<managed T>` stays the reference width (4).**

This is the semantic split §8 recorded as undecided. It is now accepted, for
four reasons:

1. **It is the only variant that does not break `StaticArray`'s own loops.**
   Measured (§1.1): `offsetof<StaticArray<u8>>()` = **0**, `offsetof<Array<u8>>()`
   = **16**, both against `sizeof` = 4. A layout-size `sizeof` makes a loop
   stepping by `sizeof<StaticArray<T>>()` step **zero** bytes and one stepping by
   `sizeof<Array<T>>()` step 16 — neither terminates correctly.
2. **It is semantically coherent.** `@unmanaged` has C semantics: the value is
   the storage. A managed class is a reference type: the value is a pointer. Two
   different things, two different sizes, stated by the declaration.
3. **It matches the tree's expectation.** The 33 framework `@unmanaged`
   declarations (`ogre/wire.ts` 24, `runtime/wire.ts` 9) are C records mirroring
   host structs; `sizeof` on them is C `sizeof`. `offsetof<T>()` already returns
   that number and the tree relies on it 128 times.
4. **The `store` refusal follows the same predicate** — `Type.isUnmanaged`
   (`types.ts:356-359`) — so one predicate governs two intrinsics, and the fourth
   piece (§11) is the third. Coherence is mechanical, not stylistic: a guest's
   mental model is "this type is a C record", and `sizeof`, `load`, and `store`
   all answer to it.

**Consequence for §1's table.** The `under (A)` column is the variant this
rejects; the `under (B)` column is the operative one. Under (B), `byteSize` is
untouched, so the guarded loops (`array.ts:230,238`;
`staticarray.ts:191,198,214,221`) never see an `@unmanaged` T — they run inside
`isManaged<T>()`, which is false for one (`types.ts:346-352`). The two unguarded
sites (`array.ts:336`, `:361`) would fire only for an `@unmanaged` element
reaching `shift`/`unshift`, which no tree instantiation does (§12).

### 10.2 Decision 2 — the fix is at `builtin_sizeof`, not `byteSize`

**The phase-shape correction.** The struct phase's collateral table
(`docs/interop-scope.md` §6.1) measures a `Type.byteSize` change; its own text
says so — "A 'fix' that changes `byteSize` for class types changes the size of a
*reference* everywhere the compiler asks." The fix this phase takes is at
`builtin_sizeof` (`builtins.ts:1234-1253`), which reads `type.byteSize`
(`:1243`) and returns a constant. Changing the reader leaves the property alone,
and with it every other reader of the property:

| reader | site | under a `byteSize` change | under `builtin_sizeof` |
|---|---|---|---|
| `sizeof` | `builtins.ts:1243` | moves | moves |
| `store` width | `:2577` | moves (writes a record into a 4-byte slot) | **unchanged** |
| `store` default align | `:2561` | moves | **unchanged** |
| `load` width | `:2502-2503` | moves | **unchanged** |
| `load` default align | `:2486` | moves | **unchanged** |
| `alignof` | `:1264-1274` (`ctz(byteSize)`) | moves (a class reports 2) | **unchanged** |
| field layout | `resolver.ts:3677-3682` | moves | **unchanged** |

**The collateral therefore collapses from "compiler + std rewrite + test
re-baseline" to "latent, mostly zero tree instantiations."** §1.2's 11 std sites
are all written against the *value-width* meaning of `sizeof`
(`docs/interop-scope.md` §6.2: `array.ts`/`staticarray.ts` use it as a stride,
`map.ts`/`set.ts` as an alignment hint, `class.ts:13` pins the class case). Under
(B) they keep the meaning they were written for; only `sizeof<@unmanaged T>`
changes, and the tree has no such site (§1.3).

The bundle stays — `T[N]` + the refusal + the `sizeof` fix — but the `sizeof`
half is now **small**, not the defining risk.

### 10.3 The bundle is four pieces

`sizeof` (variant B) + `store<T>` refusal + `load<T>` refusal (§11) + `T[N]`.
The four are one release because of §3.1's internal edge (`T[N]` layout before
`sizeof` is correct for an array-bearing record) and because the C#-gold claim
needs all of them (`docs/interop-tn-scope.md` §10, reason 4). The `load` refusal
is the fourth by §11.3: same predicate, zero callers, same shape.

---

## 11. The `load<T>` refusal (the gap)

§2 refused `store<T>` and said nothing about `load<T>`. The struct phase measured
that `load<Two>(src)` returns the first field's value and `.b` then reads `0`
(`docs/interop-scope.md` §0, the premise table). It is the same mechanism, and it
is the same fix.

### 11.1 Where the width is emitted

`builtin_load` (`src/builtins.ts:2455-2510`). The width and the default alignment
both come from `type.byteSize`:

```ts
let immAlign = type.byteSize;                                  // :2486
...
return module.load(
  type.byteSize,                                              // :2503
  type.isSignedIntegerValue,
  arg0,
  outType.toRef(),
  immOffset,
  immAlign
);
```

Measured on `@unmanaged class Two { a: i32; b: i32 }`:

```wat
(func $loadprobe/loadTwo (param $0 i32) (result i32)
  i32.load )                                   ;; one word -- the reference width
(func $loadprobe/loadTwoB (param $0 i32) (result i32)
  i32.load
  call $loadprobe/Two#get:b )                  ;; offset 4 of the LOADED pointer, not of $0
```

That is the struct phase's observation reproduced: `load<Two>` yields whatever
the first word holds as a pointer, and `.b` reads offset 4 of *that*. The record
is 8 bytes (`offsetof<Two>()` = 8) and `sizeof<Two>()` = 4.

### 11.2 Callers in the tree

**Zero.**

- Every `load<` in `tension-framework` and `examples` names a concrete scalar:
  `f64` 25, `f32` 22, `u32` 18, `i32` 7, `u64` 5, `usize` 3, `u8` 3, `u16` 1,
  `i16` 1. The single `load<T>` in the text is a **comment**
  (`tension-framework/assembly/anim/reader.ts:27`); `reader.ts`'s actual reads
  are `load<u8>`/`<u16>`/`<i16>`/`<u32>`/`<i32>`/`<f32>`
  (`:81,88,95,102,109,116,151`).
- A scan of every `load<X>`/`store<X>` in the tree where `X` is one of the 34
  `@unmanaged` types → **0 hits**.
- No framework or example generic function calls `load<T>`/`store<T>` on its own
  type parameter (the same scan: 0 sites outside the comment).

### 11.3 Recommendation — fold in as the fourth piece

**Symmetric with `store<T>`**: a compile-time error at builtin evaluation,
predicate `Type.isUnmanaged` (`types.ts:356-359`), reusing diagnostic 203
(`Operation '{0}' cannot be applied to type '{1}'`, `builtin_load` already uses it
at `:2477` for a non-memory type) or a dedicated diagnostic naming
`load<usize>`/the named copy.

**Migration cost in the tree: zero** (§11.2). The refusal is a language-level
correctness fix: today `load<T>` on an `@unmanaged` T silently yields a
reference-shaped word, and nothing in the tree does it, so no consumer is
blocked and no source changes.

**The one consequence, stated as hypothetical.** `Array<T>` and `StaticArray<T>`
carry 17 + 15 `load<T>` sites and 4 + 1 `store<T>` sites
(`std/assembly/array.ts`, `staticarray.ts`). For an `@unmanaged` element those
would have to spell `load<usize>`/`store<usize>`, because an
`Array<@unmanaged T>` element *is* a reference. The tree instantiates no such
container (§12.2), so the edit is a correctness change with no live consumer —
identical to the `store` refusal's consequence (§2.3).

---

## 12. The two open items

### 12.1 (a) Does the TensionScript suite instantiate the affected generics with a class element?

**Yes — 9 sites, all managed classes, none through the affected methods.**

| test | instantiation | line |
|---|---|---|
| `tests/compiler/assert-nonnull.ts` | `Array<Foo>` | 18 |
| `tests/compiler/rt/flags.ts` | `Array<Ref>` | 43 |
| `tests/compiler/issues/1699.ts` | `Array<MultiAssignmentTest>` | 6 |
| `tests/compiler/std/array.ts` | `Array<Dim>` | 1018, 1033, 1281, 1282 |
| `tests/compiler/std/staticarray.ts` | `StaticArray<Ref>` | 34, 37 |

Enumerated by scanning every `tests/**/*.ts` for `Array<X>`/`StaticArray<X>`
where `X` is a class declared in that file.

The affected methods are exercised, but not with a class element:
`std/array.ts` has `concat` ×5, `shift` ×1, `unshift` ×2 — the `concat` block
operates on `Array<i32>` (`:188-206`) and the `shift`/`unshift` blocks on `arr`,
an `Array<i32>` (`:263-287`). `std/staticarray.ts`'s one `concat` is on the
`Array<string>` that `isArray` returns (`:125`).

**Under variant B this is zero effect**: all nine are managed classes, so
`sizeof` does not move for them, and the guarded loops do not run for them. This
is the item that could have moved variant B, and it does not.

### 12.2 (b) `Array<@unmanaged T>` after the refusal

**Zero instantiations.** The tree declares 34 `@unmanaged` types; no
`Array<...>` or `StaticArray<...>` in the framework or the examples names one
(scan over both trees, `node_modules` excluded).

Measured today, for the shape the refusal would reject: `Array<Mat4f>` compiles
and `__set`/`push` instantiate the generic `store<T>` at `array.ts:134` and
`:214`, emitting `i32.store` — a reference copy. That is the operation the
spelling change would keep, and it is why the consequence is a rename rather
than a redesign.

**So the refusal's consequence is hypothetical for this tree**, and the edit it
would require is named in §11.3.

---

## Appendix — probes and citations

**A. Sizeof/store facts** (`/tmp/szprobe/`, `@yabgu_gm/tensionscript@0.7.1`,
`--target release --runtime incremental`).

```
probe.ts:     sizeof<Mat4f> = 4      offsetof<Mat4f> = 64
              store<Mat4f>(p, m)  -> i32.store
containers.ts: sizeof<StaticArray<u8>> = 4   offsetof<StaticArray<u8>> = 0
              sizeof<Array<u8>> = 4           offsetof<Array<u8>> = 16
              sizeof<String> = 4              offsetof<String> = 0
shift.ts:     Array<Mat4f>#shift  -> i32.const 4; i32.add ... memory.copy
              Array<Mat4f>#unshift -> i32.const 4; i32.add ... memory.copy
loadprobe.ts: Two { a: i32; b: i32 }
              sizeof<Two> = 4   offsetof<Two> = 8
              load<Two>(p)      -> i32.load
              load<Two>(p).b    -> i32.load; call Two#get:b
```

**B. Caller inventories.**

```
tree store< type args: f64 37, f32 36, u32 22, u64 8, u16 2   (105 sites, 0 class)
tree load< type args:  f64 25, f32 22, u32 18, i32 7, u64 5, usize 3, u8 3,
                       u16 1, i16 1            (89 sites, 0 class; the one
                       `load<T>` occurrence is a comment, reader.ts:27)
tree load<@unmanaged T> / store<@unmanaged T>: 0
                       (scan over the 34 @unmanaged type names)
tree sizeof< sites:   sizeof<usize>() only
                      (callbacks.ts:35, guest-callbacks.ts:39,43)
tree Array<...>:      u8 19, string 3, f32 3, BoneTransform 3, u32 2, i32 2,
                      ResEntry 1, Refusal 1, FixturePair 1, ArrayBuffer 1
tree StaticArray<...>: f32 3, i32 2, u8 18
tree Array<@unmanaged T> / StaticArray<@unmanaged T>: 0
tree .concat( / .shift( / .unshift(: 0
std suite class-element Array/StaticArray: 9, all managed classes
                      (assert-nonnull.ts:18 Foo; rt/flags.ts:43 Ref;
                       issues/1699.ts:6 MultiAssignmentTest;
                       std/array.ts:1018,1033,1281,1282 Dim;
                       std/staticarray.ts:34,37 Ref)
std load<T>/store<T> in containers: array.ts 17/4, staticarray.ts 15/1
```

**C. Source citations.**

- `builtins.ts:1234-1253` (`builtin_sizeof`, `byteSize` at `:1243`);
  `:1256-1275` (`alignof`, `ctz(byteSize)`); `:1278-1332` (`offsetof`,
  `memoryOffset` at `:1306-1321`, `nextMemoryOffset` at `:1330`);
  `:2455-2510` (`builtin_load`; non-memory refusal `:2474-2478`; default align
  `:2486`; width `:2503`); `:2514-2579` (`builtin_store`; non-memory refusal
  `:2541`; default align `:2561`; width `:2577`); `:1359-1376` (`idof`, the
  `@unmanaged` predicate precedent).
- `types.ts:193-201` (`byteSize`, `alignLog2`); `:346-352` (`isManaged`);
  `:356-359` (`isUnmanaged`); `:361-380` (`isMemory`); `:74-76` (a class type is
  built from `Usize`).
- `resolver.ts:3640-3672` (declaration-order walk); `:3677-3682` (byteSize as
  alignment, power-of-two assert); `:3723` (`nextMemoryOffset`).
- `compiler.ts:8026-8032` (reference-typed await refused).
- `diagnosticMessages.json:2` (100), `:19` (203).
- `std/assembly/array.ts:134,214,230,238,336,361`; `staticarray.ts:98,191,198,
  214,221`; `map.ts:43-44`; `set.ts:41`; `task-rt.ts:117-119,564,566`.
- `tests/compiler/class.ts:13`; `tests/compiler/std/array.ts:188-206,263-287`;
  `tests/compiler/std/pointer.ts:50,55,60,65`; `tests/compiler/builtins.ts:409-421`;
  the nine class-element instantiations of §12.1 —
  `tests/compiler/assert-nonnull.ts:18`, `tests/compiler/rt/flags.ts:43`,
  `tests/compiler/issues/1699.ts:6`, `tests/compiler/std/array.ts:1018,1033,
  1281,1282`, `tests/compiler/std/staticarray.ts:34,37` — and the `concat`
  blocks the class element does not reach (`std/staticarray.ts:125`).
- `tension-framework/assembly/anim/reader.ts:27` (the `load<T>` comment),
  `:81,88,95,102,109,116,151` (the concrete loads).
- `tension-framework/package.json:31`; `examples/*/package.json` (15 at
  `^0.7.1`).
- `tension-core/include/tension_adapter.h:17,78`;
  `tension-core/src/session/arena.rs:1030-1104,1110-1200,1458,1678`;
  `tension-framework/assembly/runtime/layout.ts:16`.
- Prior scopes: `docs/interop-scope.md` §0, §6.1-§6.3 (the byteSize mechanism,
  the collateral table, the two `sizeof` semantics); `docs/interop-tn-scope.md`
  §1 (the `-O3` cost), §3.2-§3.4 (layout, nesting out), §4 (fixture), §5.3
  (hash), §7.2 (the `-O0` column); `docs/interop-surface-scope.md` §2.4
  (`(ptr,len)` ABI), §3 (dependency graph), §5/§7 (the 0.8.0 options);
  `docs/async-complete.md` (consumer state, the consumer-table discipline note).
