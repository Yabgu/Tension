# Interop phase — scoping

**Status:** scoping only. No source changed, no plan, no code.
**Base:** TensionScript `next` @ `50cceb36` (package version `0.7.1`) in
`third_party/assemblyscript`; Tension `main` @ working tree with the 0.7.1
consumers.
**Method:** every claim below was measured, not read. Two compilers were used:
the published `@yabgu_gm/tensionscript@0.7.1` (`/tmp/interop-probe/probe*.ts`,
compiled to WAT and instantiated under Node) and the tree's own `src/`. Where a
measurement contradicts the dispatch — and one does, materially — the
measurement is reported and the contradiction is named.

**Placement note.** The dispatch names `docs/interop-scope.md` in the
TensionScript repository. `AGENTS.md` hard rule 1 makes `third_party/` —
including the TensionScript submodule — read-only, and this document is not
source, so it is written here, beside the other phase scopes
(`docs/async-phase4-scope.md`, `docs/resource-async-scope.md`). If it belongs in
the TensionScript checkout, that is a `cp` on the architect's word; nothing here
has been written into `third_party/`.

---

## 0. The premise, checked first

The dispatch's reframing has two claims. One holds. One does not.

| claim | measured | verdict |
|---|---|---|
| `sizeof<T>()` returns 4 for an `@unmanaged` class | `i32.const 4` for `{a:i32;b:f64;c:i32}`, `{x:i64;y:i32}`, `{x:i32;y:f32}`, and for a managed class too | **holds** |
| `store<T>(ptr, value)` writes one word | `i32.store` — one word | **holds** |
| `load<T>(ptr)` correctly copies the data | `load<Mixed>(src)` compiles to `i32.load` and returns **the first field** (`1` for a record whose `a = 1`) | **does not hold** |

`load`, `store` and `sizeof` agree with each other. They are not two broken
builtins beside one working one; they are three consistent answers to a
different question than the phase assumed. Section 1 measures the single
mechanism behind all three. Section 6 is where that changes the phase's shape.

---

## 1. `sizeof<T>()` — the implementation

**Site:** `src/builtins.ts:1233-1253`.

```ts
// sizeof<T!>() -> usize*
function builtin_sizeof(ctx: BuiltinFunctionContext): ExpressionRef {
  ...
  let type = ctx.typeArguments![0];
  let byteSize = type.byteSize;                 // :1243
  if (!byteSize) { ...error... }
  return contextualUsize(compiler, i64_new(byteSize), ctx.contextualType);
}
```

It reads one property off the *type* — `type.byteSize` — and folds it to a
constant. There is no class branch, no field walk, no header read.

**`byteSize`:** `src/types.ts:193-195`.

```ts
/** Size in bytes. */
get byteSize(): i32 {
  return this.size + 7 >>> 3;   // bits → bytes
}
```

So `sizeof<T>` is `T`'s *value width*. For any class, that width is the pointer
width, because a class type is constructed from `usize`:

**Class type construction:** `src/program.ts:4569-4572`.

```ts
let usizeType = program.options.usizeType;
let type = new Type(usizeType.kind, usizeType.flags & ~TypeFlags.Value | TypeFlags.Reference, usizeType.size);
type.classReference = this;
```

The class type's `kind` is `TypeKind.Usize` and its `size` is 32. Therefore:

- `byteSize` = 4 for **every** class, managed or `@unmanaged` — the decorator is
  never consulted;
- `isMemory()` (`src/types.ts:361-379`) is *true*, because its switch is on
  `kind` and `TypeKind.Usize` is in the list.

That second fact is why neither `load` nor `store` rejects a class type as
non-memory; it is the same root cause, not a separate one.

**Measured returns** (published 0.7.1, `--runtime stub --optimizeLevel 0`):

| `T` | `sizeof<T>()` | `offsetof<T>()` (no arg) | `alignof<T>()` |
|---|---|---|---|
| `i32` | 4 | — | — |
| `f64` | 8 | — | — |
| `{x:i32;y:f32}` `@unmanaged` | 4 | **8** | 2 |
| `{x:i32;y:f64}` `@unmanaged` | 4 | **16** | 2 |
| `{a:i32;b:i64;c:i32}` `@unmanaged` | 4 | **20** | 2 |
| `{a:i32;b:f64;c:i32}` `@unmanaged` | 4 | **20** | 2 |
| `{x:i32;y:f64;z:i32}` managed | 4 | **20** | 2 |

`alignof` is derived, not measured separately, for the rows after the first two:
`ctz(byteSize)` with `byteSize = 4` is 2 for every class, so the column is
uniform by construction. It was measured for `{a:i32;b:f64;c:i32}` and is 2 —
a record whose `f64` needs 8-byte alignment.

**Why 4:** not a header read, not hardcoded, not a target default. It is
`usize`'s width, inherited by every class type. `alignof<T>()` shares the path
(`src/builtins.ts:1256-1276`, `ctz(byteSize)`) and therefore also reports 2
(4-byte alignment) for a record that needs 8.

**What the expected values are.** The layout the tree actually gets is in
`src/resolver.ts:3676-3684` — each field is aligned to its own size, then
advanced:

```ts
let byteSize = fieldType.byteSize;
assert(isPowerOf2(byteSize));
let mask = byteSize - 1;
if (memoryOffset & mask) memoryOffset = (memoryOffset | mask) + 1;
boundInstance.memoryOffset = memoryOffset;
memoryOffset += byteSize;
```

and finalised at `src/resolver.ts:3723` as `instance.nextMemoryOffset`.

With alignment applied, and **no** trailing pad (the resolver never rounds the
end up):

| shape | offsets | `offsetof<T>()` | C-ABI `sizeof` (with tail pad) |
|---|---|---|---|
| `{x:i32; y:f32}` | 0, 4 | 8 | 8 |
| `{x:i32; y:f64}` | 0, 8 | 16 | 16 |
| `{a:i32; b:i64; c:i32}` | 0, 8, 16 | 20 | 24 |
| `{a:i32; b:f64; c:i32}` | 0, 8, 16 | 20 | 24 |

The last two rows are the interesting ones: `offsetof<T>()` is
**allocation-true and array-unsafe**. `{a:i32;b:i64;c:i32}` has layout size 20
and alignment 8; a 20-byte stride misaligns every second element. The tree's
own record shapes never hit this (their sizes are 8/16/24/32/48/64/80/96/128/
144/208/256 — every one a multiple of its alignment), which is why nobody has
been bitten. The ogre wire says so explicitly: "Alignment is a *placement* rule,
not something offsetof can check" (`tension-framework/assembly/ogre/wire.ts:16-19`).

**`offsetof<T>()` is the size operation that exists.** `src/builtins.ts:1330`:

```ts
return contextualUsize(compiler, i64_new(classReference.nextMemoryOffset), contextualType);
```

and the compiler uses the same number as the allocation size
(`src/compiler.ts:10774-10788`, both branches), which is what makes it
authoritative rather than incidental.

---

## 2. `store<T>(ptr, value)` and `load<T>(ptr)` — the implementations

**`store` site:** `src/builtins.ts:2514-2578`. The operative line is `:2577`:

```ts
return module.store(type.byteSize, arg0, arg1, inType.toRef(), immOffset, immAlign);
```

**`load` site:** `src/builtins.ts:2455-2511`, operative line `:2502-2509`:

```ts
return module.load(
  type.byteSize,          // width
  type.isSignedIntegerValue,
  arg0, outType.toRef(), immOffset, immAlign
);
```

Both compile a single Binaryen load/store whose width is `type.byteSize`.
Neither inspects the class, its decorator, or its fields. The `!inType.isMemory`
guard (`:2541-2549` in `store`, `:2474-2481` in `load`) admits class types only
because their `kind` is `Usize` (§1).

**Measured emissions** (published 0.7.1):

| call | emitted | words touched |
|---|---|---|
| `store<i32>(p, v)` | `i32.store` | 1 |
| `load<i32>(p)` | `i32.load` | 1 |
| `store<f64>(p, v)` | `f64.store` | 1 |
| `load<f64>(p)` | `f64.load` | 1 |
| `store<Managed>(p, v)` | `i32.store` | 1 |
| `load<Managed>(p)` | `i32.load` | 1 |
| `store<Unmanaged>(p, v)` | `i32.store` | 1 |
| `load<Unmanaged>(p)` | `i32.load` | 1 |

**Runtime confirmation.** A record `{a:i32; b:f64; c:i32}` filled with
`(1, 2.5, 3)` at `0x1000`:

- `store<Mixed>(0x2000, 0x1000)` left `i32[0x2000] = 4096` and zeros at `+8`,
  `+16`;
- `load<Mixed>(0x1000)` returned `1` — the value of `a`, reinterpreted as a
  pointer;
- reading through field access on the same pointer was correct throughout:
  `a=1`, `b=2.5`, `c=3`, `b` at `+8`, `c` at `+16`.

**Why one word:** it is the same fact as §1. `T` is a class type; a `T`-typed
value is a reference; a reference is one word. `store<T>` writes one T-sized
value. Under the language's own semantics this is *correct* — and it is why
`load<T>` cannot have been copying the struct either.

**The std relies on that reading.** `Array<T>.push` (`std/assembly/array.ts:207-216`)
branches on `isManaged<T>()`: the managed arm does `store<usize>` + `__link`, the
other arm does `store<T>`. For `T` an `@unmanaged` class, the second arm runs
and stores the **reference** — the only correct thing for an array of
references. The same shape is in `staticarray.ts`, `vector.ts`, `util/sort.ts`,
`util/bytes.ts`.

---

## 3. The offset inventory

Every hand-coded offset in the tree that adoption would touch. "Native" means
the site already names the field through an `@unmanaged` declaration; "raw"
means a numeric constant or an intrinsic with a literal offset.

### 3.1 `std/assembly/task.ts` — `TaskRecord` (managed, 32 B)

| field | offset | type | declared | read/written by |
|---|---|---|---|---|
| `class_` | 0 | i32 | `task.ts:41` | `task-rt.ts:295` (field), `task-rt.ts:198` (field) |
| `key` | 4 | i32 | `:43` | `task-rt.ts:198` (field) |
| `payload` | 8 | i32 | `:45` | `task-rt.ts:296` (field) **and** raw `base + RECORD_PAYLOAD` (`task-rt.ts:569`) **and** compiler-emitted `offset = 8` (`src/compiler.ts:8047`) |
| `status` | 12 | i32 | `:47` | `task-rt.ts:252`, `:297`, `:385`, `:545` (all field) |
| `f0` | 16 | f32 | `:49` | raw `base + RECORD_F0` (`task-rt.ts:565,567`) **and** compiler `offset = 16` (`src/compiler.ts:8045`) |
| `f1` | 20 | f32 | `:51` | nothing reads it directly; the 64-bit read spans 16..24 |
| `tag` | 24 | i32 | `:53` | nothing today |
| `done` | 28 | i32 | `:55` | `task-rt.ts:253`, `:298`, `:386`, `:546` |

The record is **managed**, not `@unmanaged` — deliberately, so that
`Task<T>._record` is a traced reference (`task.ts:29-35`). Its size is 32 via
layout, and `sizeof<TaskRecord>()` would say 4. `TaskSlot` (`task-rt.ts:146-153`)
and `TaskState` (`task-rt.ts:56-93`) declare no offsets at all — pure field
access, managed, correct today.

Raw offsets in std: `task-rt.ts:117` (`RECORD_PAYLOAD = 8`), `:119`
(`RECORD_F0 = 16`), used at `:565-569`.

### 3.2 `src/async/lower.ts` and the compiler's await read

`lower.ts` emits **no** `load`/`store`/`sizeof`. It emits a call to
`__taskCompleteResult<R>(state, value)` (`src/async/lower.ts:177-188`; emitted at `:2701`) precisely
so that the offset decision happens once, in std, on the *resolved* `R`. The
read half is codegen, not the transform: `src/compiler.ts:8043-8067` chooses
`offset = 16` for `f32/f64/i64/u64` and `offset = 8` otherwise, then emits
`module.load(type.byteSize, …, record, type.toRef(), offset, type.byteSize)`.

So the live offsets are 8 and 16, written twice: `src/compiler.ts:8045,8047` and
`std/assembly/task-rt.ts:117,119`.

### 3.3 `tension-framework/assembly/runtime/wire.ts` — 9 `@unmanaged` classes

| class | size | fields (offset) | check lines |
|---|---|---|---|
| `ArenaControl` | 256 | magic 0, formatVersion 8, schemaVersion 10, abiVersion 12, flags 14, totalSize 16, layoutHash 20, regionCount 24, regionTableOff 28, manifestOff 32, manifestLen 36, reserved0-14 40..160, state 160, faultCode 164, faultDetail 168, pad0 172, sessionNonce 176, reserved15-23 184..256 | 308-321 |
| `SessionInfo` | **128 (stale — see §4)** | magic 0, abiVersion 8, schema 10, flags 12, pad0 14, arenaSize 16, maxArenaSize 20, memoryBase 24, initialPages 28, maxPages 32, layoutHash 36, regionCount 40, classCount 44, capacity0-9 48..88, openNonce 88, reserved0-3 96..128 | 324-338 |
| `RegionDesc` | 24 | kind 0, flags 4, offset 8, size 12, align 16, reserved 20 | 341-347 |
| `TableHeader` | 32 | head 0, tail 4, capacity 8, stride 12, generation 16, dropped 20, delivered 24 | 350-357 |
| `EventRecord` | 32 | seq 0, class_ 8, flags 12, a 16, b 20, f0 24, f1 28 | 360-367 |
| `StringHalf` | 16 | offset 0, length 4, capacity 8, flags 12 | 370-374 |
| `Callbacks` | 64 | abiVersion 0, slotCount 2, flags 4, onBatch 8, onEvent 12, reserved0-5 16..64 | 377-382 |
| `Subscription` | 16 | class_ 0, mode 4, flags 8, reserved 12 | 385-389 |
| `FrameState` | 64 | frameIndex 0, droppedEvents 4, faultState 8, lastError 12, reserved0-5 16..64 | 392-396 |

Class ids (`wire.ts:46-65`): `CLASS_*` 0..12, frozen, AI family 10-12 appended.
Region ids (`:68-79`): `REGION_*` 0..11. Sizes (`:84-92`): `EVENT_RECORD_SIZE` 32,
`TABLE_HEADER_SIZE` 32, `CALLBACKS_SIZE` 64, `SUBSCRIPTION_SIZE` 16,
`STRING_HALF_SIZE` 16. Header offsets (`:97-102`): `CONTROL_OFFSET` 0,
`SESSION_INFO_OFFSET` 0x100, `REGION_TABLE_OFFSET` 0x200, `REGION_DESC_SIZE` 24.

### 3.4 `runtime/arena.ts` — views, not offsets

| site | line | what it does |
|---|---|---|
| `ctrl()` | `:41` | `changetype<ArenaControl>(CONTROL_OFFSET)` |
| `sessionInfo()` | `:46` | `changetype<SessionInfo>(SESSION_INFO_OFFSET)` |
| `regionDesc(kind)` | `:59` | `changetype<RegionDesc>(0x200 + kind*24)` |
| `regionOffset/regionSize` | `:63-71` | field reads on the descriptor |
| `verifyCanary` | `:116` | `load<u64>(at)`, `load<u64>(at + 8)` — raw, deliberate (lattice) |
| `gapStart` | `:120-133` | descriptor loop, field reads |

This file is already the pattern the phase wants: `@unmanaged` + `changetype` +
named field access, with only the canary's `+8` raw.

### 3.5 `runtime/layout.ts` — generated, no offsets

`:16-26`: `ABI_VERSION`, `LAYOUT_HASH`, `ARENA_SIZE`, `MAX_ARENA_SIZE`,
`MEMORY_BASE`, `INITIAL_PAGES`, `MAXIMUM_PAGES`, `CLASS_COUNT`,
`RING_CAPACITIES`. Generated by `tension-framework/build.sh` from `session.json`;
never hand-edited.

### 3.6 Other raw-offset sites (the balance of the inventory)

| file | lines | offsets | type | already `@unmanaged`? |
|---|---|---|---|---|
| `ogre/wire.ts` | 62-458 | 13 declarations: **11 `@unmanaged`** — Transformf, Aabbf, SceneNode, LightRecord, CameraRecord, Material, Resource, Renderable, MotionUpdate, BoneUpdate, Job — and **2 plain structs**, Vec3fValue and QuatfValue, the value twins the transform records nest. Thirteen further declarations were pruned for zero consumers on 2026-10-30 (commit `88012ee`): Vec2f, Vec3f, Vec3f16, Vec4f, Quatf, Colourf, Mat4f, StringRef, BufferRef, TextureSlot, ShaderRecord, ResourceReq, Buffer | declarations | **yes** |
| `ogre/wire.ts` | 516-687 | `RESOURCE_SIZE` 48, `RESOURCE_*_OFFSET` 8/12/16/40, `JOB_SIZE` 64, `SCENE_*_SIZE` (72/80/88), `MATERIAL_SIZE` (200), `RENDERABLE_SIZE` (56), `MOTION_SIZE` 48, `BONE_SIZE` 48, `SKIN_SIZE` 32, table bases | size constants | **derived** — the five record sizes are `sizeof<T>()` since 2026-10-30; `RESOURCE_SIZE`, `JOB_SIZE`, `MOTION_SIZE`, `BONE_SIZE` and `SKIN_SIZE` are still literals |
| `ogre/index.ts` | 226, 351-358, 364-406 | `changetype<Job>(regionOffset(REGION_JOB) + (id-1)*JOB_SIZE)`; `recordSlot` + `memory.copy(at, record, SIZE)` | view + copy | yes (constant-sized copy) |
| `ogre/bones.ts` | 141-155 | 0,4,8,16..60 | 15 `store<u32/f32/u64>` | **no** — raw writes into a `BoneUpdate`-shaped slot |
| `ogre/motion.ts` | 79-93, 111-125 | 0,4,8,16..60 | 30 `store<…>` | **no** — raw |
| `ogre/skin.ts` | 87-92 | 0,4,8,12,16,24 | 6 `store<…>` | **no** — raw |
| `input.ts` | 73-91 | `STATE_*_OFFSET` 0,4,8,12,16,48,52,56,60,64,68,72,76,80; `PAD_*` 4,8,16 | size/offset constants | **no** — no record type at all |
| `input.ts` | 180-190, 208, 217-224 | the same offsets via `load<i32/f32/u64>`; `keysAt + (scancode>>5)*4` | reads | **no** |
| `res.ts` | 104-121 | `statBuf` +0/+4/+8 | 3 `load<u32>` | **no** — `StatRecord` is a managed mirror class |
| `physics.ts` | 154-208 | `i*8`, `base+n` × 8 | `load/store<f64>`, computed stride | **no** — flat `f64[]` ABI, by design |
| `anim/reader.ts` | 81-116 | sequential `this.offset` | `load<u8/u16/i16/u32/i32/f32>` | **no** — cursor, not records |
| `std/rt/common.ts` | 30-37 | — | `BLOCK_OVERHEAD = offsetof<BLOCK>()` | **yes** — the idiom, in std |
| `examples/solver/collision/game.ts` | 56-68 | stride `offsetof<SphereProps>()`, `+8` | `store/load<f64>` | **yes**, with the comment explaining why `sizeof` is not used |

**Completeness.** `grep -rn "offsetof<"` over `tension-framework/assembly`
returns 127 lines: **73 calls in `runtime/wire.ts`, 63 in `ogre/wire.ts`**
(some lines carry two calls via `||`). The dispatch's "75 offsetof checks" is
the *line* count in `runtime/wire.ts` (75, of which 2 are comment mentions at
`:10` and `:299`). The framework total is **136 calls**, not 75. `std` adds 48
`offsetof<` occurrences, all in std's own runtime/array/map/pointer idioms.

---

## 4. The layout hash's coverage

**Site:** `tension-core/src/session/arena.rs:1030-1104`. Read-only measurement;
nothing in `tension-core` was touched.

Folded, in order:

1. header geometry — `REGION_COUNT`, `REGION_DESC_SIZE`, `MANIFEST_ENTRY_SIZE`,
   `TYPE_COUNT`, `HEADER_PAGE_SIZE`, `CONTROL_OFFSET`, `CONTROL_SIZE`,
   `SESSION_INFO_OFFSET`, `SESSION_INFO_SIZE`, `REGION_TABLE_OFFSET`,
   `MANIFEST_OFFSET`, `LAYOUT_FLOOR`;
2. the region table — 12 × `(kind, flags, size, align)`;
3. the type catalogue — 9 × `(id, size, align)`;
4. field offsets, **name then offset**, for nine tables (`CONTROL_FIELDS` 15,
   `SESSION_INFO_FIELDS` 14, `TABLE_FIELDS` 7, `REGION_DESC_FIELDS` 6,
   `CALLBACKS_FIELDS` 5, `EVENT_FIELDS` 7, `STRING_HALF_FIELDS` 4,
   `SUBSCRIPTION_FIELDS` 4, `FRAME_STATE_FIELDS` 4 = 66 pairs);
5. scalar constants — `CLASS_COUNT`, four modes, four states, four faults,
   `EVENT_RECORD_SIZE`, `RING_HEADER_SIZE`, 13 ring capacities.

Recorded value: `786_288_195` (`arena.rs:1678`), which is also `session.json`'s
and `layout.ts`'s.

**Do the guest's checks read from the declarations?** Yes and no, and the
distinction is the whole of question 7. Each check is
`offsetof<T>("field") != <literal>` — the **left** side is computed from the
`@unmanaged` declaration, the **right** side is a hand-copied constant that came
from the Rust layout. The check proves *declaration == hand-copy*. It does not
prove *hand-copy == Rust*, and nothing in the guest can prove that; that is what
`layout_hash` is for, and it is computed on the host from Rust constants.

**Measured defect: `SessionInfo` is stale.** The guest declares 10 capacities and
`openNonce` at 88, total 128 (`wire.ts:159-192`; verified
`offsetof<SessionInfo>() = 128`, `offsetof<SessionInfo>("openNonce") = 88`). The
Rust host has 13 capacities from 48 → 100, `openNonce` at **104**, and
`SESSION_INFO_SIZE = 144` (`arena.rs:54,101`). Nothing in the guest reads
those fields — only `regionCount` (`arena.ts:124`) — so the disagreement is
latent, and the guest's own check asserts the declaration faithfully
(`wire.ts:334-338`) — which is exactly why the drift is invisible: the check
proves declaration == literal, and the literal was copied before 0.6.0a added
three classes. Any move to derive the guest's layout from its declarations must
fix this first, or the derived hash cannot equal `786_288_195`.

**Tradeoff for question 7, stated without choosing:**

- *Derive the hash in the guest from declarations.* Pro: the 136 `offsetof`
  checks and the hash become one source, and the hash covers *field names*,
  which the offsets alone do not. Con: the hash's authority moves from
  `session.json`/Rust to a third derivation; the guest would have to reproduce
  FNV-1a over names, ids and constants byte-for-byte, including `SESSION_INFO`
  at its true 144-byte shape; and every adapter (all 16 consumers, the OGRE DSO,
  the input DSO) is rebuilt against a number that is now computed twice. That is
  the 0.6.0a pattern — a coordinated release.
- *Keep the hash on the host; keep the checks in the guest.* Pro: no hash move,
  no adapter rebuild, the current cross-check keeps doing its job (it catches a
  guest built against a stale declaration). Con: two hand-maintained copies of
  each constant, and the `SessionInfo` drift shows the copies can diverge
  silently.

**What does *not* move the hash:** changing `sizeof`/`store`/`load` semantics,
and adopting `@unmanaged` field access at any site in §3. The hash folds Rust
constants and names; none of the three intrinsics appear in it. This is measured
from the fold list, not assumed. The only thing that would move it is a change
to the record *shape* or to what the fingerprint *covers*.

---

## 5. What `@unmanaged` already does at the ABI boundary

**Counts, measured.** `tension-framework/assembly` has **33** class declarations
carrying `@unmanaged`: 24 in `ogre/wire.ts`, 9 in `runtime/wire.ts`. The
dispatch and `docs/async-complete.md:92` both say **39**. The 39 is not
reproducible from this tree; `grep -c "@unmanaged"` gives 39 *decorator lines*,
six of which are comment mentions (`runtime/wire.ts:3,302`,
`runtime/callbacks.ts:53`, `ogre/wire.ts:3,6,19`). Recorded here so the number in
the next document is the measured one.

**Worked example — real records, real offsets** (published 0.7.1; compiled
against a copy of `runtime/wire.ts`, instantiated under Node):

```
ArenaControl#get:state          i32.load offset=160     ← state at 160
ArenaControl#get:sessionNonce   i64.load offset=176     ← nonce at 176
EventRecord#get:class_          i32.load offset=8       ← class_ at 8
TableHeader#get:delivered       i64.load offset=24      ← delivered at 24
offsetof<ArenaControl>()  = 256      sizeof<ArenaControl>() = 4
offsetof<EventRecord>()   =  32      sizeof<EventRecord>()  = 4
offsetof<TableHeader>()   =  32      sizeof<TableHeader>()  = 4
```

Field access is exactly right, alignment included, with no `sizeof` involved.
What is *not* available is an inline sub-record: `SceneNode` contains twelve
`f32` and a `u64`, not a `Transformf`, because an `@unmanaged` class field holds
a **reference** (`ogre/wire.ts:5-9`, `:455-460`). That is the boundary that
makes "struct-in-struct" out of scope (§8).

**The 136 `offsetof` checks** check the declaration against a hand-copied
literal (§4). They are compile-time: the whole `wireOffsetsProblem()` function
folds to `null` or to a string constant, and `checkWireOffsets()` /
`checkOgreWireOffsets()` are called from the guest's first instructions because
a module-level statement would become a `start` section the host refuses
(`wire.ts:399-424`).

---

## 6. Design questions

### 6.1 Where the fix lives

The question presumes the fix is in a builtin, the compiler, or `@unmanaged`
codegen. The measurement says the fix is in **none of them**, because
`sizeof<Class> == 4` is not a bug in a builtin — it is the pointer width of a
class-typed value, and the same chain makes `load`/`store` one word. A "fix" that
changes `byteSize` for class types changes the size of a *reference* everywhere
the compiler asks, not only at the two call sites the phase cares about.

If, despite that, the semantics are changed, the blast radius is measurable:

| site | today | if `sizeof<Class>` = layout size |
|---|---|---|
| `std/assembly/array.ts:230,238` | `offset += sizeof<T>()` inside `isManaged<T>()` → stride 4 | stride 20/32/etc. — **loop cannot terminate correctly** |
| `std/assembly/staticarray.ts:191,198,214,221` | same | same |
| `std/assembly/array.ts:214` | `store<T>` writes the reference | would write 20 bytes into a 4-byte slot |
| `std/assembly/map.ts:43-44`, `set.ts:41` | `sizeof<K>()` as an alignment hint | changes entry stride/padding (behaviour, not correctness) |
| `tests/compiler/class.ts:13` | `assert(sizeof<Animal<f64>>() == sizeof<usize>())` | **re-baseline** |

So: a compiler change, a std change, and a test re-baseline, all at once — a
minor release (`0.8.0`), not a patch. The narrower "only `@unmanaged` classes"
variant avoids the two loops and the test re-baseline, but it still breaks
`array.ts:214` (an `Array<UnmanagedClass>` stores references), and it makes
`sizeof<@unmanaged T>` mean something different from `sizeof<managed T>` for two
types whose values are both references. That is a language-design decision, not
an implementation one.

The phase as *reframed* needs no compiler change: `offsetof<T>()` already returns
the layout size, the tree already uses it 136 times, and the missing piece is a
**named copy operation** rather than a changed intrinsic. A std addition (e.g. a
`copyStruct<T>(dst, src)` in std, or a framework helper) is a std change → a
TensionScript package bump, no release of the compiler proper.

### 6.2 `sizeof`'s semantics

Today: the width of a `T`-typed **value**. For a class that is a reference (4);
for `i32` 4; for `f64` 8. It excludes padding entirely because it never sees the
layout. `offsetof<T>()` is the other thing: layout bytes with inter-field
alignment, **no trailing pad**, equal to the allocation size. There is no
existing operation that returns the C-ABI size (layout + tail pad); `map.ts:53`
shows the idiom for rounding up when someone needs it.

Existing call sites expect the value semantics. `array.ts`/`staticarray.ts` use
`sizeof<T>()` as a *stride* in reference loops; `map.ts`/`set.ts` use it as an
alignment hint; `tests/compiler/builtins.ts:409-421` pins primitives;
`tests/compiler/class.ts:13` pins the class case to the pointer size. None of
them was "written around the bug" — they are correct for the semantics that
exist. Nothing in `tension-framework` calls `sizeof` at all except
`callbacks.ts:35` (`sizeof<usize>()`, a pointer, correct).

### 6.3 `store`'s semantics

Today: store one `T`-sized value; for a class, one word — the reference. Not the
head field only: the *whole value*, which happens to be a pointer. For a managed
class it writes no header, because there is no header write in `store` at all;
`new` is what writes headers (`src/compiler.ts:10784-10788`).

The correct "copy a struct" operation, if one is added, is a `memory.copy` of
`offsetof<T>()` bytes starting at `changetype<usize>(value)`. There is no
struct-typed value in the language to do it implicitly — an `@unmanaged` class
value is a reference — so the copy has to be spelled:
`memory.copy(dst, changetype<usize>(src), offsetof<T>())`. That is the
`placeRecord` idiom (`ogre/index.ts:355-358`) and the `Pointer<T>` test's idiom
(`tests/compiler/std/pointer.ts:25-27`). Field-by-field is what
`changetype<T>(offset).field = …` already compiles to (measured in §5), and it is
what `bones.ts`/`motion.ts`/`skin.ts` hand-roll.

A `store<T>` that memcpy'd `offsetof<T>()` bytes would be wrong for a managed
class (it would copy a reference value into non-traced memory and bypass
`__link`) and wrong for `Array<UnmanagedClass>`. If such an operation is wanted,
it must be a *new* builtin/std function, not a changed `store`.

### 6.4 The three-way fixture

Shape: one `@unmanaged` class with mixed widths, three ordered assertions, so a
half-fix fails at the third.

```ts
@unmanaged
class Mixed { a: i32 = 0; b: f64 = 0; c: i32 = 0 }   // expect a@0, b@8, c@16, size 20

// 1. Field access — passes today. The baseline that must never regress.
const src = heap.alloc(offsetof<Mixed>());
const m   = changetype<Mixed>(src);
m.a = 1; m.b = 2.5; m.c = 3;
assert(m.a == 1 && m.b == 2.5 && m.c == 3);
assert(load<i32>(src) == 1 && load<f64>(src + 8) == 2.5 && load<i32>(src + 16) == 3);

// 2. The size operation. `offsetof` already answers the layout question; the
//    question is whether the phase gives it a name of its own.
assert(offsetof<Mixed>() == 20);          // passes today — the operation exists
assert(layoutSize<Mixed>() == 20);        // placeholder for the design's name;
                                          // this is 4 today if it is `sizeof`
assert(load<f64>(src + 8) == 2.5);        // the layout, proved by use

// 3. The copy — fails while the copy is missing, passes only when it exists.
const dst = heap.alloc(offsetof<Mixed>());
copyStruct<Mixed>(dst, m);              // the std helper, whatever it is named
assert(load<i32>(dst) == 1 && load<f64>(dst + 8) == 2.5 && load<i32>(dst + 16) == 3);
assert(memory.compare(dst, src, 20) == 0);   // byte-identical, padding included
```

Three states:

- **broken** (today): the `layoutSize<Mixed>()` line fails at 4 (or, if the
design keeps `sizeof`, passes — and then assertion 3 is the only failing one).
This is the "the gap is real" evidence, and it runs against the *published*
compiler.
- **partial** (size named, no copy): assertions 1-2 pass, 3 fails. This is the
  state a one-intrinsic fix ships in — the discipline note the `break`/`continue`
  phase already established.
- **complete**: all three pass.

Two details the fixture must get right, both measured. First, **`alignof` does not
follow `sizeof` automatically**: `builtin_alignof` is `ctz(byteSize)`
(`src/builtins.ts:1256-1276`), so a `sizeof<Mixed>` of 20 gives `ctz(20) = 2` —
still a 4-byte alignment, though the record's `f64` wants 8. A faithful
alignment operation needs `max(field alignments)`, which is a third intrinsic,
not a consequence of the size fix. The fixture therefore asserts the layout by
*use* (`load<f64>(src + 8)`), not by `alignof`. Second, the byte-comparison in
assertion 3 must use the *same* padding on both sides, which a freshly zeroed
`heap.alloc` gives; a fixture that compares a struct built by field assignment
against a wire image with non-zero padding is testing initialisation, not
copying.

### 6.5 Adoption order (candidate, not implemented)

Ranked by (readers × risk) ÷ blast radius:

1. **`runtime/wire.ts` + `arena.ts`** — already `@unmanaged`, already
   `changetype`, already field access. The only change is replacing the
   hand-copied size constants (`EVENT_RECORD_SIZE`, `TABLE_HEADER_SIZE`,
   `CALLBACKS_SIZE`, `SUBSCRIPTION_SIZE`, `STRING_HALF_SIZE`) with
   `offsetof<T>()`, and fixing the stale `SessionInfo` declaration. Zero call-site
   churn; the checks become self-proving. This is also where the hash question
   would land if it were ever opened (§4) — the measurement says it need not be,
   which is what keeps this site first.
2. **`task-rt.ts:117,119`** — the two raw offset constants become
   `offsetof<TaskRecord>("payload")` / `("f0")`. The record is managed, and
   `offsetof` works on managed classes (measured: 20 for a managed
   `{i32,f64,i32}`), so this converts with no decorator change. Smallest diff,
   highest read frequency.
3. **`ogre/bones.ts:141-155`, `motion.ts:79-93,111-125`, `skin.ts:87-92`** — 51
   raw `store` calls become field assignment on `changetype<BoneUpdate>` etc. The
   declarations already exist; the writes are the only raw sites left in the
   framework that build a declared record by hand.
4. **`input.ts`** — needs a *new* `@unmanaged` `InputState`/`PadState`
   declaration (none exists today) before anything can convert. That is new
   surface, sized at ~20 fields, and it is the only site where adoption adds code
   rather than replacing it. Separate phase.
5. **`res.ts:104-121`** — three loads; `StatRecord` is a managed mirror class
   because it is returned by value. Converting means making it `@unmanaged` and
   returning a pointer, which changes the public shape of `stat()`. Separate
   phase, and arguably not worth it for three words.
6. **The transform's emitted read** — last, and only if the compiler release is
   already happening. See §6.6.

`physics.ts`, `anim/reader.ts` and `std/rt/*` are not candidates: the first two
are flat numeric ABI (no record), the third is std's own allocator working as
designed.

### 6.6 The transform's emitted reads

`lower.ts` emits no offsets (§3.2). The offsets are in codegen
(`src/compiler.ts:8043-8048`) and in std (`task-rt.ts:117,119`). So:

- Converting **std's** reads is a std change (`TaskRecord` already declares the
  fields; `offsetof<TaskRecord>("payload")` is a compile-time constant).
- Converting **codegen's** read to field access would be a compiler change, and
  it would need the record's declaration available to codegen — currently it
  knows only a `TaskRecord` *reference* and a numeric offset, because the
  lowering's side table carries the record expression, not the class
  (`src/async/lower.ts:177-188`).
- The two must agree. If std converts and codegen does not, the offsets are
  still 8 and 16 on both sides — identical machine code, different spelling —
  and no compatibility question arises. That is the cheapest split: **std
  converts, codegen keeps raw offsets, and a check asserts the two agree**.

The version boundary follows: *std-only conversion → package bump*;
*codegen conversion → compiler release* (0.7.2 at the earliest, 0.8.0 if
`sizeof`/`store` semantics move with it).

### 6.7 The layout hash recompute

Answered in §4. Summary: not required by any fix in this phase; `sizeof`/`store`
are not folded. Deriving the guest's hash from declarations would move the
authority and therefore the release shape (0.8.0, every adapter rebuilt, the
0.6.0a pattern), and it would fail today because the guest's `SessionInfo`
declaration is 128 bytes/10 capacities/nonce 88 against the host's 144/13/104.
Recompute is a **no** until that drift is fixed and the derivation is proven
byte-identical.

### 6.8 Not in scope

- **`@unmanaged` classes as generic parameters** with layout-dependent
  behaviour. `MapEntry<K,V>`/`SetEntry<T>` are generic and `@unmanaged`
  (`map.ts:24-29`, `set.ts:23-28`), and `offsetof<MapEntry<K,V>>()` is already
  used at `map.ts:53` — so the *instantiation* works. What is not in scope is
  promising a layout for `K`/`V` that are themselves records.
- **`@unmanaged` arrays beyond fixed size.** `Array<T>` holds references;
  there is no inline-struct array, and `fill`/`concat`/`push` assume reference
  stride (§6.1). A fixed-size `@unmanaged` class used as a block (`SphereProps`)
  is in scope; a growable one is not.
- **Zero-copy views over host memory beyond what the tree does.** `changetype`
  views over the arena (0..8 MiB) and the ring are in scope; mapping arbitrary
  host pointers, or letting a guest hold one across a call, is not — the arena
  is the only memory the host promises.
- **Struct-in-struct containment.** An `@unmanaged` class field holds a
  *reference* (`ogre/wire.ts:5-9`); there is no inline sub-record. Every
  container record in the tree spells its sub-record out flat — `SceneNode`
  writes the twelve floats a `Transformf` would have held — and that stays true.

---

## 7. What would force a "no"

1. **Changing `sizeof`/`store` semantics.** Measured to break six array/
   staticarray loops, one array store, two entry-alignment heuristics and one
   test (`§6.1` table), for a capability that `offsetof<T>()` already provides.
   If the architect insists on the literal framing, that is a 0.8.0 with a std
   rewrite, and this document's recommendation becomes "not this phase".
2. **A hash move.** Not required by anything here. If a proposal makes the guest
   derive the hash, it is a coordinated release across all 16 consumers plus two
   DSOs, and it cannot produce `786_288_195` until `SessionInfo` is corrected.
3. **A fixed-size-record promise in the language.** If `sizeof<@unmanaged T>`
   must be the C-ABI size (with tail pad), the resolver has to round
   `nextMemoryOffset` up — which changes allocation sizes and therefore every
   `__new` for an unmanaged class. Not this phase.
4. **The `alignof` question resolving the other way.** `alignof<Mixed>()` = 2
   today. If the design requires struct alignment from `alignof`, that is a third
   intrinsic with the same blast radius as `sizeof`.

None of these is a dead end; each is a scope boundary with a measured cost.

---

## 8. Recommendation

**Proceed — but not as "fix two intrinsics".** Fixing `sizeof`/`store` is a
semantics change with measured collateral, and the capability the phase actually
wants (a record's layout size, and a byte copy of it) already exists as
`offsetof<T>()` + `memory.copy` — 136 call sites in the framework, and std's own
runtime idioms (`rt/common.ts:37`, `rt/itcms.ts:46`, `map.ts:53`) built on it. The phase's real content is: name the copy operation once, then convert the
raw-offset sites that build declared records by hand.

Evidence for "already works": 33 `@unmanaged` classes, 136 `offsetof` checks,
field access emitted at the correct offsets with correct alignment (§5), the
arena's whole view layer built on it (§3.4), and one example that already
documents why it uses `offsetof` instead of `sizeof`
(`examples/solver/collision/game.ts:56-68`).

Candidate phase breakdown (for the architect; nothing here is a plan):

- **A — the copy operation (std, package bump).** One `memory.copy`-backed
  function usable over an `@unmanaged` record, plus the three-way fixture. No
  compiler change, no hash move.
- **B — the smallest conversion (std).** `task-rt.ts`'s two offset constants
  become `offsetof<TaskRecord>(…)`, with a check that codegen's 8/16 still
  agrees. Package bump.
- **C — the framework's size constants (framework).** `runtime/wire.ts` sizes
  become `offsetof<T>()`; `SessionInfo` is corrected to the host's shape
  (128 → 144, 10 → 13 capacities, nonce 88 → 104) — **this one is a separate
  finding and should be its own small phase regardless of the rest**, because it
  is a latent wrong-offset waiting for the first reader.
- **D — the hand-rolled record writes (framework).** `bones.ts`, `motion.ts`,
  `skin.ts` become field assignment on the existing declarations.
- **E — `input.ts` (framework, new surface).** Needs adjudication: declaring the
  record is new API, not adoption.
- **F — codegen's await read (compiler, 0.8.0).** Only if A-E prove the pattern
  and the release is happening anyway.

**Version boundary, stated plainly:** A-D need no compiler change — a
TensionScript package bump (0.7.2) for A/B, a framework package bump for C/D. F
is a compiler release. A change to `sizeof`/`store`/`alignof` semantics is a
compiler release **and** a std change **and** a test re-baseline, i.e. 0.8.0.

**Open questions for the architect:**

1. Is the intended operation "the layout size of the pointee" (which
   `offsetof<T>()` is) or "the size of a `T`-typed value" (which `sizeof` is)?
   The phase's name for it is the design decision; the implementation follows.
2. `{a:i32;b:i64;c:i32}` has layout size 20 and alignment 8. Is a 20-byte stride
   ever acceptable, or must the language's size operation include the tail pad
   (24)? The tree has never needed it; a host ABI might.
3. Is the `SessionInfo` drift (C) in this phase or its own?
4. Does `alignof` move with `sizeof`, or stay tied to the value width?
