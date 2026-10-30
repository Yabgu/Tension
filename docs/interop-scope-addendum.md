# Interop phase — scoping addendum

**Status:** second scoping pass. Read-only. No source changed, no plan, no code.
**Base:** the same tree as `docs/interop-scope.md` (TensionScript `next` @
`50cceb36`, package `0.7.1`; Tension `main` working tree).
**Relationship to the original:** the original stands as written. This document
corrects one claim, one wording, and one inference, answers five open items, and
records two new measurements that were not in the first pass.

**Method.** Two compilers exist and both were used where they differ: the
published `@yabgu_gm/tensionscript@0.7.1` (what the sixteen consumers run) for
every compile-output claim, and the tree's own `src/` for reading. Runtime
claims are from `tension-core` — the real host, `target/debug`, a bare guest run
— not from Node and not from `--runtime stub`. The one place a Node run appears
it is labelled as such.

**What this pass changes in the original, in one list:**

| # | where | change |
|---|---|---|
| 1 | §0 and §2 of the original | the claim "`load` does not copy" is **confirmed on the real host**, with the two-cell fixture the dispatch asked for; the *provenance* of the contrary belief is identified (a store→load round trip through a reference) |
| 2 | §4 and §7 clause 2 of the original | "it cannot produce `786_288_195` until `SessionInfo` is fixed" is **corrected**: fixing the guest declaration does **not** move the hash. The hash covers the *host's* shape (144/104), which is already correct; the guest is the side that disagrees |
| 3 | §4 of the original | "Nothing reads those fields, so it has never failed" is **downgraded** to "unread today, unverified that nothing will", and the concrete wrong read a future reader would get is named |
| 4 | §6.5 item 1 of the original | the caution "this is the site that can touch the hash question" is **resolved**: it does not. C is a framework-only change |
| 5 | §8 of the original | the A–D list and the four "no" conditions are lifted verbatim into this document with their repo/version annotations (item 3 below) |
| 6 | §6.3 of the original | the `store<T>` deferral is made explicit, with its dependency on the Docs menu item (item 4 below) |
| 7 | §6.8 of the original | the four exclusions are **swept against all 33 declarations**: zero hits in every category, with the evidence per category (item 5 below) |

Nothing else in the original is reopened. The root cause, the recommendation's
shape, the collateral list, the 0.8.0 implication and the two count corrections
(33 declarations, ~136 `offsetof` sites) all stand.

---

## Item 1 — the load fixture: settled on the real host

### What was run

A guest compiled with the published `@yabgu_gm/tensionscript@0.7.1`:

```
tensionscript loadcell2.ts --outFile loadcell2.wasm \
  --runtime incremental --optimizeLevel 0 --noAssert \
  --initialMemory 2 --exportStart __start
```

run on the real host:

```
tension-core/target/debug/tension-core /tmp/interop-probe/loadcell2.wasm
```

No session was opened (`--session-open` absent), no adapter was loaded. The
guest logs through the host's own `tension::io::log`, so the numbers below are
the host's, read from guest memory by the host's shim.

### The result

Source record: `@unmanaged class Two { a: i32; b: i32 }`, written at
`src = 16` with `[src] = 1`, `[src+4] = 0xDEADBEEF`, logged with the same values
the fixture wrote.

| cell | expression | observed | meaning |
|---|---|---|---|
| control | `changetype<Two>(src).b` | `0xdeadbeef` | the record is laid out correctly and the field path is good |
| 1 (dispatch's shape) | raw `load<One>(src)` where `One { a: i32 }` | `1` | **passes — but for the wrong reason** |
| 1 (field read) | `load<One>(src).a` | `0` | the returned value is `1`, dereferenced at address 1 |
| 2 (dispatch's shape) | raw `load<Two>(src)` | `1` | a four-byte load of `a` |
| **2 (the distinguishing read)** | `load<Two>(src).b` | **`0x0`** | **≠ `0xDEADBEEF` → `load` did not copy** |
| verdict line | — | `LOAD DID NOT COPY` | — |

Host exit 0; the log lines are the evidence, not the exit code.

### The emitted widths (compile output, same artifact)

From `loadcell2.wat`, published 0.7.1, `--optimizeLevel 0`:

```
(func $loadcell2/Two#get:b (param $0 i32) (result i32)
  local.get $0
  i32.load offset=4          ← field access: 4 bytes at +4 of whatever it is given
)
```

and at both load sites inside `_start_game`, a bare `i32.load` with no offset —
`load<One>` and `load<Two>` are the same instruction. `cell.wat` shows the same
pair as `cell1raw`/`cell2raw`, byte-for-byte identical functions.

So the compile-output half is dispositive on its own: a 4-byte load cannot
produce `b`'s bytes. The runtime half confirms it on the real host.

### Provenance — both observations, named

**The first pass's own observation (the one that says "does not copy").**
Provenance, exactly:

- **record**: `@unmanaged class Mixed { a: i32; b: f64; c: i32 }` — three
  fields, widths 4 / 8 / 4, layout 20;
- **backend**: WebAssembly instantiated in Node (`run3.mjs`), **not**
  `tension-core` — the discipline note's real-backend rule was not met by that
  observation, which is why the fixture above was run on the host;
- **runtime flag**: `--runtime stub --optimizeLevel 0 --noAssert`;
- **observation**: `load<Mixed>(0x1000)` returned `1` (a's value);
  `readB(load<Mixed>(0x1000))` returned `0` (it read offset 4 of address 1).

**The contrary belief's origin.** `docs/async-complete.md:95-98` states
"`store<T>(ptr, value)` writes **one word** — while `load<T>(ptr)` correctly
copies the data", and attributes it at `:87` to "the scoping pass that was
started and interrupted" — i.e. a pass *before* `docs/interop-scope.md`. It is
reproducible, and it is a round-trip artefact. Under stub in Node the same probe
also ran:

```
store<Mixed>(dst, src);              // dst ← 4096 (src's address)
load<Mixed>(dst)          → 4096     // one word, read back
readB(load<Mixed>(dst))   → 2.5      // b of the record AT 4096 — correct by aliasing
```

Two of those three lines are true for a pointer round trip and prove nothing
about copying. Re-run on the **real host** for this addendum:

| expression | observed |
|---|---|
| `store<Two>(dst, rec)` where `rec = 0x10` (a record pointer) | `dst` holds `0x10` |
| `load<Two>(dst).b` | `0xdeadbeef` — correct |
| `store<Two>(dst, load<Two>(src))` (a record read, then stored) | `dst` holds `0x1` |
| `load<Two>(dst).b` | `0x0` — wrong |

The first two lines are the illusion: store writes the address, load reads the
address, field access then works because the word *is* the record's address.
Nothing was copied. The moment the stored value is a record read rather than a
pointer, the round trip breaks.

**Verdict on the first pass's root-cause story: it stands, unchanged.** `load`,
`store` and `sizeof` are three consistent answers to "how wide is a `T`-typed
value", and for a class that answer is one pointer. The dispatch's contrary
premise is explained, not refuted: it is the round-trip shape, which aliases
correctly and copies nothing.

**Discipline note, recorded specifically.** This is a third instance of "the
middle state is what ships", and it has a distinct shape from the `break`
case: there, the partial fix *half-worked*; here, the **test shape** half-works.
A fixture that stores a pointer and reads it back passes on a broken intrinsic.
The fixture that distinguishes is: write a record field-by-field at a fresh
address, call `load<T>` on **that address**, and read the **second** field. One
field is not enough (Cell 1 passes either way); a round trip is not enough (it
passes either way).

---

## Item 2 — the layout-hash fold: SessionInfo does *not* move it

### The fold, line by line

`tension-core/src/session/arena.rs:1030-1104`. Every input, with its line:

| line | input | value today |
|---|---|---|
| 1034 | `REGION_COUNT` | 12 |
| 1035 | `REGION_DESC_SIZE` | 24 |
| 1036 | `MANIFEST_ENTRY_SIZE` | 8 |
| 1037 | `TYPE_COUNT` | 9 |
| 1038 | `HEADER_PAGE_SIZE` | 0x1000 |
| 1039 | `CONTROL_OFFSET` | 0 |
| 1040 | `CONTROL_SIZE` | 256 |
| 1041 | `SESSION_INFO_OFFSET` | 0x100 |
| **1042** | **`SESSION_INFO_SIZE`** | **144** |
| 1043 | `REGION_TABLE_OFFSET` | 0x200 |
| 1044 | `MANIFEST_OFFSET` | 800 |
| 1045 | `LAYOUT_FLOOR` | 6 250 528 |
| 1048-1053 | `REGIONS` × 12: `(kind, flags, size, align)` | table at `arena.rs:415-428` |
| 1056-1060 | `TYPES` × 9: `(id, size, align)` | table at `arena.rs:442-452` |
| 1066-1081 | nine field tables, `name` then `offset` | see below |
| 1084 | `CLASS_COUNT` | 13 |
| 1085-1088 | `MODE_DIRECT`, `_BATCHED`, `_RING`, `_POLLED` | 1, 2, 3, 4 |
| 1089-1092 | `STATE_UNINIT`, `_READY`, `_FAULTED`, `_CLOSED` | 0, 1, 2, 3 |
| 1093-1096 | `FAULT_CALLBACK_TRAP`, `_DEVICE_LOST`, `_OOM`, `_SHUTDOWN` | 1, 2, 3, 4 |
| 1097 | `EVENT_RECORD_SIZE` | 32 |
| 1098 | `RING_HEADER_SIZE` | 32 |
| 1099-1101 | `DEFAULT_RING_CAPACITIES` × 13 | 1, 256, …, 16 (`arena.rs:266-267`) |

The nine field tables and their contents:

| table | line | pairs |
|---|---|---|
| `CONTROL_FIELDS` | 1067 (def. 1159-1175) | 15 |
| **`SESSION_INFO_FIELDS`** | **1068 (def. 1177-1192)** | **14** |
| `TABLE_FIELDS` | 1069 (def. 1194-1202) | 7 |
| `REGION_DESC_FIELDS` | 1070 (def. 1110-1117) | 6 |
| `CALLBACKS_FIELDS` | 1071 (def. 1119-1125) | 5 |
| `EVENT_FIELDS` | 1072 (def. 1127-1135) | 7 |
| `STRING_HALF_FIELDS` | 1073 (def. 1137-1142) | 4 |
| `SUBSCRIPTION_FIELDS` | 1074 (def. 1144-1149) | 4 |
| `FRAME_STATE_FIELDS` | 1075 (def. 1151-1156) | 4 |

Within `SESSION_INFO_FIELDS`, the two that matter:
`("class_capacity", SESSION_INFO_CLASS_CAPACITY)` at `arena.rs:1190` (constant
`= 48`, `:96`) and `("open_nonce", SESSION_INFO_OPEN_NONCE)` at `arena.rs:1191`
(constant `= 104`, `:101`).

### Are the guest's SessionInfo checks among the folded constants?

**No.** The fold reads Rust `const`s only. The guest's numbers — `openNonce`
at 88, ten capacities, size 128 — live in
`tension-framework/assembly/runtime/wire.ts:159-192` and are never parsed by
Rust. The only framework file the Rust side reads is the *generated*
`assembly/runtime/layout.ts` (`tension-core/tests/framework_layout.rs:61`, `:123`),
and it reads `LAYOUT_HASH`, `ARENA_SIZE`, `MAX_ARENA_SIZE` and `MEMORY_BASE`
from it — not the declarations.

So the two are **separate verification paths**, and the original's §4 said so in
effect without naming it: `layout_hash` is a host-side fingerprint over Rust
constants, checked at `session_open`; the guest's `offsetof` checks are
compile-time assertions over TS declarations, run by whichever guest calls
`assertWireOffsets()`. Neither reads the other's source. That separation is
exactly why fixing the guest cannot move the hash.

One further measurement, because it sharpens the hazard: **only the framework's
two test guests call the check** — `tests/guest-open.ts:42` and
`tests/guest-ogre.ts:77-78` — and no example does
(`grep -rn "assertWireOffsets()" examples` → empty). The check is opt-in, and
the shipping guests do not opt in. So the guest's checks could assert a stale
shape for three releases without anyone noticing, which is precisely what the
`SessionInfo` drift is.

### Measured, not read: the fold replicated and perturbed

The fold was reimplemented from the list above (FNV-1a: `struct Fnv` at `arena.rs:1205`, `fn u32` at `:1215`, little-endian bytes)
and checked against the host binary:

| what | value |
|---|---|
| replication, host shape (size 144, nonce 104, capacity 48) | **786288195** |
| `tension-core layout-hash` (the host binary) | **786288195** |
| replication, if the *host* adopted the guest's stale shape (128 / 88 / 48) | 764944835 |
| replication, only `SESSION_INFO_SIZE` → 128 | 2729333875 |
| replication, only `open_nonce` → 88 | 2750677235 |

Reproducing `786288195` proves the transcription of the fold is complete — a
missed or extra input would not reproduce it. The perturbed values prove the
fold genuinely covers the *host's* SessionInfo shape, and would move if the host
changed.

### The answer, and the correction to (b)

**(a) and (b) in the original's §4 are about two different things, and (b)'s
wording conflated them.**

- Fixing the **guest's** `SessionInfo` declaration touches no Rust constant, so
  `layout_hash()` is unchanged at `786288195`. **No hash move. No coordinated
  release. C is a framework-only change.**
- A **guest-side derivation** of the hash (the idea §4's tradeoff paragraph
  entertains) would, today, compute `764944835` from the guest's declarations —
  because the guest's declarations are stale. That is what (b) meant, and it is
  true only of the derivation proposal, not of the fix.

Corrected wording for §4, for the record: *"Deriving the hash in the guest from
its declarations would not reproduce `786_288_195` until the guest's
`SessionInfo` declaration is corrected; fixing that declaration does not move
the host's hash, because the host's hash never depended on the guest's
declaration."*

### "Nothing reads those fields" — corrected

The original said "Nothing reads those fields, so it has never failed." That is
inference from non-crash, which the pipeline notes forbid. Measured:

- the **guest** reads exactly one `SessionInfo` field, `regionCount`
  (`arena.ts:124`, offset 40 — correct in both shapes);
- no guest code reads `capacity0..9`, `classCount` or `openNonce`
  (`grep -rn "\.capacity[0-9]\|\.openNonce\|\.classCount" tension-framework/assembly`
  → only the check lines at `wire.ts:334-337`);
- the **host** writes all thirteen capacities (`arena.rs:587-592`) and the
  nonce (`arena.rs:594`), and never reads `SessionInfo` back.

So: **unread today, unverified that nothing will.** And the hazard is concrete,
not hypothetical. The host's layout is thirteen capacities at 48..100, padding
to 104, then the nonce at 104..112 (`arena.rs:96-101`). The guest's declaration
stops at ten capacities (48..88) and puts `openNonce` at 88..96
(`wire.ts:159-192`). So a guest that read `openNonce` today would read the
host's `capacity10` and `capacity11` — two capacity words presented as a u64
nonce — and a guest that read `reserved1` would read the nonce's low half. The
wrongness is offset-dependent: `regionCount` (40) and `classCount` (44) happen
to agree, `capacity0..9` happen to agree, and everything from 88 onward does
not. That is the worst shape for a latent bug — most reads are right. It is not
a crash; it is silent wrong data, which is the failure mode the pipeline notes
name.

---

## Item 3 — the A–D list and the four "no" conditions, in the record

### The phase breakdown, verbatim from the original §8

> Candidate phase breakdown (for the architect; nothing here is a plan):
>
> - **A — the copy operation (std, package bump).** One `memory.copy`-backed
>   function usable over an `@unmanaged` record, plus the three-way fixture. No
>   compiler change, no hash move.
> - **B — the smallest conversion (std).** `task-rt.ts`'s two offset constants
>   become `offsetof<TaskRecord>(…)`, with a check that codegen's 8/16 still
>   agrees. Package bump.
> - **C — the framework's size constants (framework).** `runtime/wire.ts` sizes
>   become `offsetof<T>()`; `SessionInfo` is corrected to the host's shape
>   (128 → 144, 10 → 13 capacities, nonce 88 → 104) — **this one is a separate
>   finding and should be its own small phase regardless of the rest**, because it
>   is a latent wrong-offset waiting for the first reader.
> - **D — the hand-rolled record writes (framework).** `bones.ts`, `motion.ts`,
>   `skin.ts` become field assignment on the existing declarations.
> - **E — `input.ts` (framework, new surface).** Needs adjudication: declaring the
>   record is new API, not adoption.
> - **F — codegen's await read (compiler, 0.8.0).** Only if A-E prove the pattern
>   and the release is happening anyway.

Annotated with what each touches, which repo, and which bump. ("TensionScript
repo" means `third_party/assemblyscript`, published as `@yabgu_gm/tensionscript`;
"framework repo" means `tension-framework`, its own package at `0.1.0`.)

| item | touches (file:line) | repo | bump |
|---|---|---|---|
| **A** | new function in `std/assembly/` (no site yet — the function does not exist) | TensionScript | package bump — `0.7.2` if released alone |
| **B** | `std/assembly/task-rt.ts:117`, `:119`; call sites `:565`, `:567`, `:569` | TensionScript | package bump, same release as A |
| **C** | `runtime/wire.ts:84-92` (five size constants), `:159-192` (SessionInfo declaration), `:324-338` (its check literals) | framework | framework package bump; **measured this pass to move no hash** |
| **D** | `ogre/bones.ts:141-155` (15 stores), `ogre/motion.ts:79-93` + `:111-125` (30), `ogre/skin.ts:87-92` (6) | framework | framework package bump |
| **E** | `input.ts:73-91` (offset constants), `:180-190`, `:208`, `:217-224` (reads) — plus a new declaration that does not exist | framework | framework bump **and** an API decision |
| **F** | `src/compiler.ts:8043-8048` (the await read), optionally `:10774-10788` if `sizeof` moves with it | TensionScript | compiler release — `0.8.0` |

### The four "no" conditions, verbatim from the original §7

> 1. **Changing `sizeof`/`store` semantics.** Measured to break six array/
>    staticarray loops, one array store, two entry-alignment heuristics and one
>    test (`§6.1` table), for a capability that `offsetof<T>()` already provides.
>    If the architect insists on the literal framing, that is a 0.8.0 with a std
>    rewrite, and this document's recommendation becomes "not this phase".
> 2. **A hash move.** Not required by anything here. If a proposal makes the guest
>    derive the hash, it is a coordinated release across all 16 consumers plus two
>    DSOs, and it cannot produce `786_288_195` until `SessionInfo` is corrected.
> 3. **A fixed-size-record promise in the language.** If `sizeof<@unmanaged T>`
>    must be the C-ABI size (with tail pad), the resolver has to round
>    `nextMemoryOffset` up — which changes allocation sizes and therefore every
>    `__new` for an unmanaged class. Not this phase.
> 4. **The `alignof` question resolving the other way.** `alignof<Mixed>()` = 2
>    today. If the design requires struct alignment from `alignof`, that is a third
>    intrinsic with the same blast radius as `sizeof`.

Annotated with the dead end each represents and the measurement that detects it:

| # | design dead end | which measurement detects it |
|---|---|---|
| 1 | a language where "size of a value" and "size of a layout" are one intrinsic, at the cost of the array/staticarray reference strides | the original §6.1 collateral table; **this pass confirms the premise was the round-trip illusion** (item 1), so the rewrite would buy nothing `offsetof` does not already give |
| 2 | a guest that computes its own layout fingerprint, making the fingerprint a second derivation of the same shape | **item 2 of this pass**: host hash `786288195`; guest-derived `764944835`; the fold table shows why (the guest's 128/88 vs the host's 144/104) |
| 3 | a tail-padded record size, i.e. C-ABI `sizeof` semantics for `@unmanaged` | **re-measured this pass** (compile output, published 0.7.1): `offsetof<Wide>()` where `Wide { i32, i64, i32 }` = **20**; the C-ABI size would be **24**. The tree's never needed 24 |
| 4 | struct alignment inferred from a size intrinsic rather than from the fields | **measured this pass**: `alignof<Mixed>()` = **2** while the record holds an `f64`; `alignof` is `ctz(byteSize)`, so a size fix cannot produce 8-byte alignment |

None of the four is detected by a change in the tree today; each is a boundary
that a *proposal* would cross, and each has a number attached. Three of the four
numbers were measured in this pass (`offsetof<Wide>` 20, `alignof<Mixed>` 2,
the guest-derived hash `764944835`); the fourth (#1) is the original's
collateral table plus this pass's Item 1, which removes its premise.

---

## Item 4 — the `store<T>` deferral, stated so it cannot ride implicit

**What `store<T>` is.** A one-value store whose width is the width of a
`T`-typed value. For a class `T` that value is a reference, so `store<T>` is a
**reference store**: it writes one word, the address. It is not a struct copy,
it has never been a struct copy, and the compiler does not refuse the calls that
treat it as one.

**What the phase ships instead.** The named copy (item A) is the struct copy.
Until 0.8.0, any `@unmanaged` struct copy uses the named copy. `store<T>` keeps
its reference semantics.

**The gap that remains, named as a 0.8.0 item.** After A–D, this still
compiles and still writes one word:

```ts
store<SceneNode>(slot, node);   // intended: copy 80 bytes. Actual: write 4.
```

Nothing refuses it, warns about it, or diagnoses it; the failure surfaces later
as another record's bytes read as this one's. **The refusal is a 0.8.0 item**
(it needs a definition of "used as a struct" that does not also reject
`Array<T>`'s legitimate `store<T>` at `std/assembly/array.ts:214`, so it is not
a one-line diagnostic). This addendum does not propose how to implement it.

**The dependency, surfaced.** Because the compiler will not refuse the wrong
call, the only guard between A and 0.8.0 is documentation — which makes this
phase depend on **menu item 5 (Docs)** in `docs/async-complete.md:105-106`:

> 5. **Docs.** The async plan's §4.8 validation walk and the closures plan both
>    carry measured-but-unexplained observations that belong in one place.

Specifically, the Docs item must carry, in one place a guest author will find
it: `sizeof`/`alignof`/`load`/`store` are value-width operations
(`docs/interop-scope.md` §1-§2); `offsetof<T>()` is the layout size (§1); the
named copy is the struct copy (A); and the round-trip illusion that makes
`store`→`load` look correct (item 1 above). Without that, A–D land a helper
beside an intrinsic that silently does the wrong thing — the exact shape the
pipeline notes call "a silent failure with no trap and no error".

The dependency is stated, not scheduled: this addendum does not order Docs
before or after A–D, because that is the architect's call.

---

## Item 5 — the exclusions, swept against all 33 declarations

### The categories, tested

**(a) Inline fixed-size scalar array field — `data: f32[4]`.**
The syntax does not exist. Measured:

```
tensionscript syntax.ts
ERROR TS1005: ']' expected.
 1 │ @unmanaged class A { data: f32[4]; }
   │                               ~
```

It is a parser error for any class, not an `@unmanaged`-specific refusal. The
closest spellings that do compile are references, not inline bytes: measured
`offsetof<A>()` where `A { data: StaticArray<f32> }` → **4**, and where
`B { data: ArrayBuffer }` → **4**.

**Verdict: zero — and the exclusion is moot today.** No declaration can use it.

**(b) Array of `@unmanaged` structs.**
Zero declarations have an array-typed field of any kind:
`grep -nE "^\s+\w+[!?]?:\s*(Array|StaticArray|ArrayBuffer|Float32Array|Int32Array)"`
over both wire files → empty. Zero usages of `Array<WireType>` in
`tension-framework` or `examples` (grep for each of the 24 + 9 names → empty).

Note what the tree does instead, because it matters for A: `ogre/index.ts:351-358`
hand-rolls the array — `recordSlot(region, tableBase, id, size)` plus
`memory.copy`. That is an array of records by arithmetic, not a language
construct, and it is exactly what the named copy would serve.

**Verdict: zero.**

**(c) Struct-in-struct — `@unmanaged class Outer { inner: Inner }`.**
Zero declarations embed another wire type: every field in all 33 is a scalar
(`u16/u32/u64/i32/f32`); the only non-scalar match in either file's scanned
range is a static factory's parameter list (`ogre/wire.ts:203`), not a field.
`Mat4f` is sixteen `f32` on four lines, not a nested matrix type (`:81-85`);
`SceneNode` flattens `Transformf`'s twelve floats into its own fields
(`:138-171`).

The construct *compiles*, and it is a reference, not containment — measured:

```ts
@unmanaged class Inner { x: f32; y: f32 }
@unmanaged class Outer { a: i32; inner: Inner; b: i32 }
offsetof<Inner>() = 8    offsetof<Outer>() = 12
offsetof<Outer>("inner") = 4    offsetof<Outer>("b") = 8
```

`inner` is a **4-byte pointer at offset 4**; `Outer` is 12 bytes where an inline
`Inner` would have made it 16. So a record written that way would put a guest
address where the host expects two floats. The exclusion in the original is
therefore not merely a scope choice — it is a correctness boundary the tree
currently respects by spelling every sub-record out flat.

**Verdict: zero in the tree; the construct exists and is a pointer.**

**(d) Generic parameter — `@unmanaged class Foo<T>`.**
Zero of the 33 declare type parameters:
`grep -nE "class \w+<"` over both files → empty. (The generic+`@unmanaged`
precedent in the tree is std's `MapEntry<K,V>` at `std/assembly/map.ts:24` and
`SetEntry<T>` at `set.ts:23`, which are not wire declarations and not in the
33.)

**Verdict: zero.**

### The sweep table

`a` = inline fixed-size scalar array field; `b` = array-of-struct field;
`c` = embedded `@unmanaged` type; `d` = type parameter. Zero is stated per
cell, not left blank.

The fifteen types this table once listed that no longer exist — `Vec2f`,
`Vec3f`, `Vec3f16`, `Vec4f`, `Quatf`, `Colourf`, `Mat4f`, `StringRef`,
`BufferRef`, `TextureSlot`, `ShaderRecord`, `ResourceReq`, `Buffer`,
`Transformf` and `Aabbf` — were pruned from the tree on 2026-10-30 for zero
consumers, and their rows went with them. **Every row below names a declaration
that still exists.** The `ogre/wire.ts` line numbers are the pre-prune ones: the
measurement is what this table records, and renumbering it would hide that.

| declaration | file:line | (a) | (b) | (c) | (d) |
|---|---|---|---|---|---|
| `SceneNode` | `ogre/wire.ts:138` | 0 | 0 | 0 | 0 |
| `LightRecord` | `ogre/wire.ts:175` | 0 | 0 | 0 | 0 |
| `CameraRecord` | `ogre/wire.ts:235` | 0 | 0 | 0 | 0 |
| `Material` | `ogre/wire.ts:283` | 0 | 0 | 0 | 0 |
| `Resource` | `ogre/wire.ts:374` | 0 | 0 | 0 | 0 |
| `Renderable` | `ogre/wire.ts:405` | 0 | 0 | 0 | 0 |
| `MotionUpdate` | `ogre/wire.ts:462` | 0 | 0 | 0 | 0 |
| `BoneUpdate` | `ogre/wire.ts:489` | 0 | 0 | 0 | 0 |
| `Job` | `ogre/wire.ts:509` | 0 | 0 | 0 | 0 |
| `ArenaControl` | `runtime/wire.ts:108` | 0 | 0 | 0 | 0 |
| `SessionInfo` | `runtime/wire.ts:159` | 0 | 0 | 0 | 0 |
| `RegionDesc` | `runtime/wire.ts:196` | 0 | 0 | 0 | 0 |
| `TableHeader` | `runtime/wire.ts:207` | 0 | 0 | 0 | 0 |
| `EventRecord` | `runtime/wire.ts:224` | 0 | 0 | 0 | 0 |
| `FrameState` | `runtime/wire.ts:236` | 0 | 0 | 0 | 0 |
| `StringHalf` | `runtime/wire.ts:256` | 0 | 0 | 0 | 0 |
| `Callbacks` | `runtime/wire.ts:265` | 0 | 0 | 0 | 0 |
| `Subscription` | `runtime/wire.ts:284` | 0 | 0 | 0 | 0 |
| **total** | 18 declarations (9 OGRE, 9 runtime) | **0** | **0** | **0** | **0** |

Since all four are zero, **no exclusion is a "no" condition** — the phase can
proceed as recommended without absorbing any of them. The architect should read
that as measured, not assumed: the sweep covered every declaration, and the two
constructs that *do* exist (c and d) are absent from the tree.

### The adjacent counts

**51 versus 136 — additional, not a subset.** The 136 is the original's count
of `offsetof<` sites across `tension-framework/assembly`; counted precisely for
this addendum it is **135 call sites** (73 in `runtime/wire.ts`, 62 in
`ogre/wire.ts`) plus three comment mentions (138 occurrences in all) — the
original's 136 summed 73 with 63, and ogre's 63 includes one comment mention at
`ogre/wire.ts:14`. The point is unchanged: these are compile-time layout checks,
not raw writes. The 51 hand-rolled stores are
`store<` calls in three files that contain **zero** `offsetof<` between them:

```
offsetof< counts:  bones.ts 0,  motion.ts 0,  skin.ts 0
store<    counts:  bones.ts 15, motion.ts 30, skin.ts 6   (= 51)
```

A conversion of D therefore removes 51 raw stores and adds 0 `offsetof` sites of
the kind those 135 describe; the two numbers measure disjoint things.

**Do any of the 51 copy a struct-with-array payload?** They copy scalars, except
one line: `ogre/skin.ts:93` —
`memory.copy(this.data + used, changetype<usize>(matrices.dataStart), bytes)` —
which copies a **Float32Array's data**, not a struct field. No declaration in
the 33 has an array field (category b, zero), so the named copy does not need to
handle arrays. The constraint for D is the reverse: skin's existing
`memory.copy` must stay, because that payload is the one thing in the three
files that is not a record at all. Converting skin's six scalar stores must not
disturb it.

**Ogre's 24 declarations — embedding result: zero.** No `@unmanaged` declaration
in the framework embeds another. The math types that would be the obvious
candidates are flat: `Mat4f` sixteen `f32`, `Transformf` twelve, `Aabbf` eight;
`SceneNode` and `Renderable` each spell a full transform out inline rather than
naming `Transformf`. The comment at `ogre/wire.ts:5-9` states the rule and the
tree obeys it. **"Struct-in-struct out of scope" is not violated by the tree
that ships today.**

---

## Appendix — every probe in this pass, with its raw output

For auditability, the observations each claim rests on. All fixture sources and
wasm live in `/tmp/interop-probe/`; none is in the repo.

**A. The load fixture, on the real host** (`loadcell2.wasm`, published 0.7.1,
`--runtime incremental`, run under `tension-core/target/debug/tension-core`):

```
src = 16, [src] = 1, [src+4] = 0xdeadbeef
control: changetype<Two>(src).b = 0xdeadbeef
cell1: raw load<One>(src) = 1
cell1: load<One>(src).a = 0
cell2: raw load<Two>(src) = 1
cell2: load<Two>(src).b = 0x0
cell2: verdict = LOAD DID NOT COPY
```

**B. The round trip, on the real host** (`roundtrip.wasm`):

```
roundtrip: dst holds 0x1 (src is 16)
roundtrip: load<Two>(dst).b = 0x0
pointer roundtrip: dst = 0x10, load<Two>(dst).b = 0xdeadbeef
```

**C. The emitted widths** (`loadcell2.wat`, `cell.wat`): `load<One>` and
`load<Two>` are both a bare `i32.load`; `Two#get:b` is `i32.load offset=4`.

**D. The fold** (`python3` replication of `arena.rs:1030-1104` vs the host
binary):

```
replication (host shape 144/104/48): 786288195
tension-core layout-hash:            786288195
host adopting guest's shape:         764944835
only SESSION_INFO_SIZE = 128:        2729333875
only open_nonce = 88:                2750677235
```

**E. The size operations** (`guard.wat`, published 0.7.1, compile output):

```
mixedSize   (offsetof<Mixed>)  20     Mixed = {i32, f64, i32}
mixedAlign  (alignof<Mixed>)    2
mixedSizeof (sizeof<Mixed>)     4
wideSize    (offsetof<Wide>)   20     Wide  = {i32, i64, i32}
wideAlign   (alignof<Wide>)     2
```

**F. Struct-in-struct is a reference** (`nest2.wat`, non-nullable variant):

```
offsetof<Inner>() = 8     Inner = {f32, f32}
offsetof<Outer>() = 12    Outer = {i32, Inner, i32}
offsetof<Outer>("inner") = 4
offsetof<Outer>("b") = 8
```

**G. Inline arrays are not a syntax** (`syntax.ts`):

```
ERROR TS1005: ']' expected.
 1 │ @unmanaged class A { data: f32[4]; }
```

and the reference spellings measure 4 (`stat.wat`: `offsetof<A>` where
`A { StaticArray<f32> }` → 4; `B { ArrayBuffer }` → 4).

**H. The adjacent counts.**

```
offsetof< occurrences: runtime/wire.ts 75 (73 calls + 2 comment mentions)
                       ogre/wire.ts    63 (62 calls + 1 comment mention)
store< counts:         bones.ts 15, motion.ts 30, skin.ts 6  (= 51)
offsetof< in those:    bones.ts 0, motion.ts 0, skin.ts 0
assertWireOffsets() callers: tests/guest-open.ts:42, tests/guest-ogre.ts:77-78 — no example
Array<WireType> / StaticArray<WireType>: 0 for all 33 names
```

---

## What could not be run, stated plainly

- **A session-backed run.** The load fixture ran on `tension-core` with no
  session and no adapter (`--session-open` absent). That is the real host and
  the real guest artifact, but it is not the framework's own fixture harness
  (`tension-framework/tests/run.sh`), which opens a session. The load question
  does not depend on a session — it is a memory read — and the emitted width
  settles it independently, but the distinction is stated rather than blurred.
- **The stub-versus-incremental comparison on the host.** The fixture was
  compiled `--runtime incremental` only; the first pass's stub run was not
  repeated. The artifact question (the emitted width) is runtime-independent,
  and `cell.wat` shows the two loads are the same instruction.
- **The tree's own compiler on this fixture.** Compiles used the published
  `@yabgu_gm/tensionscript@0.7.1`, which is what the sixteen consumers run. The
  tree's `src/` was read, not executed; its `dist/asc.js` is not built in this
  checkout.
- **The float-payload cells.** The fixture used `i32` fields. `f64` in the
  second field would exercise `Two#get:b` as `f64.load offset=8`; the mechanism
  is identical (`byteSize` of the class is 4 either way), but it was not run.
- **A `Map`/`Set` runtime path.** The generic `@unmanaged` precedent
  (`MapEntry<K,V>`) was read at `map.ts:24-53`, not exercised.

## Verdict

**Item 1: the first pass's root-cause story stands.** Measured on the real host:
`load<Two>(src).b` is `0x0` where a copy would be `0xDEADBEEF`, and both loads
compile to one `i32.load`. The contrary premise is a store→load round trip
through a reference, which aliases correctly and copies nothing.

**Item 2: the hash does not move.** The fold is host-side, covers the host's
`SessionInfo` (144/104, lines 1042 and 1191), and reproduces `786288195` exactly;
the guest's 128/88 are never an input. C is a framework-only change. The
original's clause (b) is corrected; the "nothing reads those fields" sentence is
downgraded, with the concrete wrong read named.

**Items 3-5:** recorded above. No exclusion is a "no" condition; the phase's
shape is unchanged.
