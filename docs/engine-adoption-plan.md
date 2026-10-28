# Engine adoption plan — the TensionScript features now on main

**Status:** plan only. No engine source changed, nothing published, no
opportunity implemented.

**This plan assumes Phase 0 (`@abi.align(N)`) ships before Phase 4.** If the
engine adoption ships without it, Phase 4 lands with align-4 records and
`@abi.align` becomes a follow-up: nothing in Phases 1–3 depends on it (§8).

**Base:** Tension `origin/main` @ `4b42251` (this branch's base; the
measurements below were taken at `9bf9ba1`, whose tree is identical — the two
histories are content-identical rewrites, §1.2). TensionScript `origin/main` @
`0b67e3cc` (0.10.0 + #36 inline nesting + #38 the struct default flip).
Measured 2026-10-28 against the compiler built from that tree; §1.1's registry
state, §3.8's TYPES verification and §8's baseline were re-measured the same
day.

**Question.** TensionScript now has three capabilities the engine was written
without — sized enums, inline nesting, and a value-type default. Which of them
does the engine want, in what order, and what has to be true first?

---

## 0. The answer up front

**Two blockers, then three opportunities worth taking, in this order:**
Phase 0 (`@abi.align(N)` + the 0.11.0 version fix, TensionScript) → bump the
engine → verify the guest byte-identical → §3.7/§3.8 measurement → `Quat` →
nested transform records → (optional) enum tidy.

Three of the five candidate wins are real and measured. Two are not what they
looked like:

- **Nested transform records: safe, and the biggest structural win.** The
  replacement layout is **byte-identical** — `sizeof` 64, offsets 16/32/48,
  alignment unchanged — verified for both record shapes, and writes through the
  engine's own `changetype` pattern land at the same offsets. 22 pad fields go.
- **`Quat` → value: unblocked and cheap.** Zero `changetype<Quat>` sites, so the
  conversion has no migration. The win is per-frame allocations, and whether it
  is measurable is a **gate**, not a claim (§4.4).
- **`BoneTransform` → value: blocked**, correctly. It needs `Array<@inline
  struct>`, which the compiler refuses by name.
- **Sized enums: no byte win.** Zero enum-typed record fields and zero enum
  arrays in the whole guest, so a narrower enum saves nothing. Worth type safety
  only.
- **The struct flip: no migration.** Zero plain `struct` declarations in the
  engine.

---

## 1. The two blockers

### 1.1 The publish gap — step 1 is a release, not an install

`tension-framework/package.json` declares `@yabgu_gm/tensionscript: ^0.10.0`.
What is actually installed is **neither that name nor that version**:

| | declared | installed |
|---|---|---|
| package name | `@yabgu_gm/tensionscript` | `@acakar/tensionscript` (the pre-rename scope) |
| version | `^0.10.0` | `0.9.0` |

`node_modules/@yabgu_gm/` does not exist at all; `node_modules/@acakar/tensionscript`
is 0.9.0. So the engine's declared dependency resolves to nothing, and the
compiler it builds with is 0.9.0 — **before** sized enums, before inline nesting
(#36), before the struct default flip (#38).

**And 0.10.0 would not be enough even if it were installed.** Sub-phase A and
the flip are on `origin/main` but unreleased; `package.json` still says `0.10.0`.

**Therefore the first step is a TensionScript release, and it is a breaking one:**
a bare `struct` changing from a pointer to a value is a semantic change, so the
number must move to **0.11.0**, not 0.10.1.

The publish is the user's credential action; this plan only states the order:

1. **Bump TensionScript to 0.11.0.** The breaking change is already described in
   its CHANGELOG (`Unreleased — breaking: plain struct is inline by default`).
2. **Registry verify** — the five-step ritual this fork uses: version visible,
   dist contents match the tree, `bin/tensionscript.js` runs from the published
   tarball, the published `package.json` name is the new scope, and a fixture
   compiles with the *published* rather than the local build.
3. **Bump the engine to `^0.11.0`** and reinstall, which also fixes the scope
   mismatch (`@acakar` → `@yabgu_gm`).
4. **Rebuild the framework and verify the guest is byte-identical** (§8).

**Measured 2026-10-28 22:10 — the release is a re-number, not a rebuild.** The
registry says `@yabgu_gm/tensionscript` has exactly two versions,
`0.0.0-stage` and `0.10.0` (`dist-tags.latest = 0.10.0`, published
`20:26:54Z`); `@acakar/tensionscript` stops at `0.10.0`. **There is no 0.11.0 to
install.** What *is* published as 0.10.0 already contains the flip: the tarball's
`dist/asc.js` is byte-identical to the local build of `0b67e3cc` (915,141 bytes,
md5 `9e0d04a20c92757bf6e02730c04932d2`), and a probe that nests a plain struct in
an `@unmanaged` record reports `sizeof` 24 on it versus **16** on the installed
`@acakar` 0.9.0 — the flip, shipped under an unchanged version number, with its
CHANGELOG entry still headed `## Unreleased — breaking`. So step 1 is: retitle
that entry `## 0.10.0`, add `## 0.11.0`, bump `package.json`, publish (Phase 0).

Two consequences for the engine side, both measured: the scope already moved in
#35 — `tension-framework/package.json` declares `@yabgu_gm/tensionscript
^0.10.0`, so Phase 1 changes **one number per file**, not the scope; and the
package declares `binaryen` as a dependency but does not bundle it, so a probe
run straight from an unpacked tarball needs an install beside it.

**A symptom worth knowing:** the rename is live, and stale installs fail loudly
rather than subtly. The TensionScript primary checkout, re-pointed at
`0b67e3cc` with a `dist/` built before the rename, dies with
`ERR_MODULE_NOT_FOUND: Cannot find package '@acakar/tensionscript' imported from
dist/asc.js`. Expect the same shape in the engine until step 3.

### 1.2 The history divergence — checked, and it is only a rename

The TensionScript history was rewritten upstream: the tree this plan was
analysed on (`27b57652`) and `origin/main` (`0b67e3cc`) are **1597 commits apart
in both directions**, with identical commit messages and different SHAs. Before
trusting any measurement, the whole tree was diffed:

```
git diff 27b57652 0b67e3cc          # not just src/ std/ tests/ docs/
```

**Result: 14 files, and every changed line is one of two string substitutions.**

- `@acakar/tensionscript` → `@yabgu_gm/tensionscript`
- `/home/acakar/work` → `/home/yabgu_gm/work`

Filtering those two patterns out of the diff leaves **0 lines**. So the rewrite
is a rename, not a content change: `src/`, `std/` and `tests/` are identical,
and the measurements below are against the right tree.

The one substantive consequence is §1.1's second row — the published scope
changed, so the engine's install must move with it.

**Pre-step for any future analysis:** run that whole-tree diff before measuring.
A clean `src/` diff is not the same as a clean tree, and here the difference was
a package name.

---

## 2. The ABI gate — which records may be restructured

`layout_hash()` (`tension-core/src/session/arena.rs:1030`) folds header geometry,
the region table, the type catalogue, and — the part that constrains this work —
**field names beside offsets** for every record a guest reads by offset:

```rust
// The *name* is hashed beside the offset, so a rename moves the hash as well as
// a move does: both change what a compiled guest's constant means.
for fields in [&CONTROL_FIELDS[..], &SESSION_INFO_FIELDS[..], &TABLE_FIELDS[..],
               &REGION_DESC_FIELDS[..], &CALLBACKS_FIELDS[..], &EVENT_FIELDS[..],
               &STRING_HALF_FIELDS[..], &SUBSCRIPTION_FIELDS[..],
               &FRAME_STATE_FIELDS[..]] { for (name, offset) in fields { … } }
```

**Name-frozen — out of scope permanently.** Nine records, 66 named fields:
`ArenaControl` (15), `SessionInfo` (14), `TableHeader` (7), `RegionDesc` (6),
`EventRecord` (7), `Callbacks` (5), `Subscription` (4), `StringHalf` (4),
`FrameState` (4). A rename moves the hash; a reorder moves it twice.

**Free — but only because nothing hashes them.** `MotionUpdate`, `BoneUpdate`,
`Renderable`, `Transformf`, `Aabbf`: **zero** occurrences anywhere in `arena.rs`.
The ogre records are read by the adapter through `guest_read` at offsets the
guest computes, and their field names are the guest's own. Their **offsets** are
the contract; their spelling is not.

That is the licence for §3, and it is narrow: it covers exactly the records whose
layout does not move anyway.

**Two hash inputs beyond the field tables**, both checked in §3.8: the manifest's
`TYPES` array is hashed too, and two of its nine entries are anonymous literals.
They pin `Callbacks` and `Subscription`, not the transform records — which is what
keeps `@abi.align(16)` off the hash.

---

## 3. Opportunity 1 — nest the transform records

### 3.1 The duplication being removed

Five records hand-flatten the same 12-scalar transform, with **16 pad fields**
in `ogre/wire.ts` alone, and a comment that says flatness is forced:

> **Flat fields, like every other record here.** An AssemblyScript field whose
> type is a class is a *reference*: `position: Vec3f` would be a 4-byte pointer
> and this record would not be 64 bytes. (`ogre/wire.ts:454-457`)

That reason no longer holds. A field whose type is a **plain struct** is now
inline, so `position: Vec3f16` *is* 16 bytes.

### 3.2 The measured replacement

Built and compiled against `0b67e3cc`, both record shapes:

| record | today | nested | size | align | offsets |
|---|---|---|---|---|---|
| `MotionUpdate` (`u32 u32 u64`, then TRS) | 64 | 64 | **same** | 3 = **same** | 16 / 32 / 48 — **same** |
| `Renderable` (4 × `u32`, then TRS — no `pad0`) | 64 | 64 | **same** | 2 = **same** | 16 / 32 / 48 — **same** |
| `Transformf` (TRS only) | 48 | 48 | **same** | — | 0 / 16 / 32 — **same** |
| `Aabbf` (min + max) | 32 | 32 | **same** | — | 0 / 16 — **same** |

The engine's own write pattern was then exercised end to end: a
`changetype<MotionUpdate>(base + i * stride)` view, then
`rec.position.x = …`, `rec.rotation.w = 1`, `rec.scale.x = …`, read back through
raw loads at 0 / 16 / 20 / 24 / 28 / 44 / 48. **All seven byte assertions pass**
(`run() = 127`).

Pads removed: `MotionUpdate` 3, `BoneUpdate` 3, `Transformf` 2, `Aabbf` 2,
`Renderable` 0 (it already uses named `positionPad`/`scalePad`, which are
structural, not padding-to-reach-16).

The guest's other six pad fields — 5 in `assembly/runtime/wire.ts`, 1 in
`assembly/runtime/manifest.ts` — are **not** in this opportunity. They sit in
records whose offsets `layout_hash` folds (§2), so they stay exactly where they
are.

### 3.3 The trap: `@inline` on the field does nothing

**Putting `@inline` on the field is a no-op if the inner type is `@unmanaged`.**
Measured: `position: @inline Vec3f16` with an `@unmanaged Vec3f16` produced
**`sizeof 32`, not 64** — the field stayed a 4-byte pointer, and the record
silently shrank by half. The identical declaration with a **plain** `Vec3f16`
gave 64 with offsets 16/32/48.

The field decorator is a use-site assertion (`resolver.ts:248` returns the type
unchanged when the request matches the declaration), so the *type* decides
storage. **The inner type must be a value type.**

### 3.4 The value twins

So each vector type needs two declarations with identical C layout. **They need
distinct names** — the sketch above cannot compile: two declarations of
`Vec3f16` are a redeclaration, and the twin has to be visibly not the other one
at every use site. The names used from here on:

```ts
@unmanaged struct Vec3f16    { x: f32 = 0; y: f32 = 0; z: f32 = 0; pad: f32 = 0; }
         struct Vec3f16Value { x: f32 = 0; y: f32 = 0; z: f32 = 0; pad: f32 = 0; }
@unmanaged struct Quatf      { x: f32 = 0; y: f32 = 0; z: f32 = 0; w: f32 = 0; }
         struct QuatfValue   { x: f32 = 0; y: f32 = 0; z: f32 = 0; w: f32 = 0; }
```

(The underscore-free suffix matches the engine's existing spelling —
`Vec3f16`, `Quatf`, `Transformf` — rather than introducing a second convention.)

**The nesting goes one way only.** Measured 2026-10-28 on both the local
`0b67e3cc` build and the published 0.10.0: a plain struct nested inside a plain
struct is refused by name —

```
AS100: Not implemented: an @inline struct nested inside an @inline value (the
outer is one WASM local per field, so the inner would have to be flattened into
the outer's leaves -- that is SROA flattening, sub-phase B)
```

— while a plain struct nested inside an **`@unmanaged`** record compiles on both,
reporting `sizeof` 24 and `offsetof("position")` 8 for
`@unmanaged struct Rec { pad0: u64; position: V3 }`. Every engine record is
`@unmanaged` (§7), so Phase 4's shape is the supported one. The rule to keep: the
value twins are leaves — they are never nested inside each other.

**Alignment, if Phase 2 says the GPU path needs 16 (§3.7, §3.8).** The twins then
carry `@abi.align(16)` too, or the outer record does, depending on what the
attribute is defined to apply to — that is a Phase 0 decision to read off the
published 0.11.0, not a guess. **Measure the aligned shape before writing it:**
`sizeof`, `alignof` and every `offsetof`, against the same numbers in the table
above. If `alignof` still reports log2 2 with the attribute applied, the
attribute did nothing and that is a Phase 0 defect, not a Phase 4 choice.

The `@unmanaged` twin stays for `changetype` views and for the `offsetof`-based
assertions; the value twin is what makes a field inline.

**Measured: the twins are byte-identical today** — `sizeof` 16/16, `alignof` 2/2,
and every field offset equal (`x` 0/0, `y` 4/4, `z` 8/8, `pad` 12/12; `Quatf`:
`x` 0/0, `w` 12/12). So the twin approach does not need a layout concession — but
it does need a **guard**, because nothing stops them drifting:

```
probe: for every field f of every twin T,
       offsetof<@unmanaged T>("f") == offsetof<plain T>("f")
       and sizeof<@unmanaged T>() == sizeof<plain T>()
```

That is the fixture §3.5 depends on: without it, a one-field edit to one twin
silently corrupts every wire record that nests the other.

### 3.5 The `offsetof` assertions become sums — exact spec

`ogre/wire.ts` asserts the flat layout in four check functions. After nesting, a
field inside a nested record has no direct `offsetof`, so each becomes a sum.
The complete rewrite, assertion by assertion:

| current (`wire.ts`) | becomes |
|---|---|
| `:822` `offsetof<MotionUpdate>("pad0") != 8` | *(unchanged — `pad0` survives)* |
| `:823` `offsetof<MotionUpdate>("positionX") != 16` | `offsetof<MotionUpdate>("position") + offsetof<Vec3f16>("x") != 16` |
| `:824` `offsetof<MotionUpdate>("rotationX") != 32` | `offsetof<MotionUpdate>("rotation") + offsetof<Quatf>("x") != 32` |
| `:825` `offsetof<MotionUpdate>("scaleX") != 48` | `offsetof<MotionUpdate>("scale") + offsetof<Vec3f16>("x") != 48` |
| `:829` `offsetof<MotionUpdate>("pad2") + sizeof<f32>() != sizeof<MotionUpdate>()` | `offsetof<MotionUpdate>("scale") + sizeof<Vec3f16>() != sizeof<MotionUpdate>()` |
| `:857` `offsetof<BoneUpdate>("positionX") != 16` | `offsetof<BoneUpdate>("position") + offsetof<Vec3f16>("x") != 16` |
| `:858` `offsetof<BoneUpdate>("rotationX") != 32` | `offsetof<BoneUpdate>("rotation") + offsetof<Quatf>("x") != 32` |
| `:859` `offsetof<BoneUpdate>("scaleX") != 48` | `offsetof<BoneUpdate>("scale") + offsetof<Vec3f16>("x") != 48` |
| `:862` `offsetof<BoneUpdate>("pad2") + sizeof<f32>() != sizeof<BoneUpdate>()` | `offsetof<BoneUpdate>("scale") + sizeof<Vec3f16>() != sizeof<BoneUpdate>()` |
| `:891` `offsetof<Transformf>("rotationX") != 16` | `offsetof<Transformf>("rotation") + offsetof<Quatf>("x") != 16` |
| `:892` `offsetof<Transformf>("scaleX") != 32` | `offsetof<Transformf>("scale") + offsetof<Vec3f16>("x") != 32` |
| `:893` `offsetof<Transformf>("pad1") != 44 \|\| … + 4 != 48` | `offsetof<Transformf>("scale") + sizeof<Vec3f16>() != 48` |
| `:894` `offsetof<Aabbf>("maxX") != 16` | `offsetof<Aabbf>("max") + offsetof<Vec3f16>("x") != 16` |
| `:895` `offsetof<Aabbf>("pad1") != 28 \|\| … + 4 != 32` | `offsetof<Aabbf>("max") + sizeof<Vec3f16>() != 32` |
| `:943` `offsetof<Renderable>("positionX") != 16` | `offsetof<Renderable>("position") + offsetof<Vec3f16>("x") != 16` |
| `:944` `offsetof<Renderable>("scalePad") + 4 != 64` | `offsetof<Renderable>("scale") + sizeof<Vec3f16>() != 64` |

Note the `pad0`/`pad1` rows: the pads that existed *to place the transform* are
deleted, so the assertion that referenced them becomes the end-of-field check
that the next field follows immediately. Each rewritten line still names the
field that moved, which is the property those functions exist for.

Two notes on reading the table. `offsetof<Vec3f16>` and `offsetof<Quatf>` mean the
**plain** twin — the one the record actually nests; the `@unmanaged` twins keep
their own `offsetof` assertions, which is what §3.4's drift probe compares
against. And `:942 offsetof<Renderable>("nodeId") != 12` is unchanged and not in
the table: `nodeId` is not a transform field.

**If `@abi.align` lands (§3.8)**, an alignment assertion is a new shape, not a
rewrite of these: the sums check offsets, and offsets do not move under a
16-byte alignment (§3.8). `alignof` cannot stand in for it either — the manifest
compares sizes only, and the guest's `manifestProblem` deliberately does not
compare its `align` entry against `alignof` (`arena.ts`, "alignment is a
consistency relation, not a comparison"). So an alignment assertion has to be
written deliberately, against the published compiler's `alignof`, and it is the
one assertion in Phase 4 that a `@abi.align` regression would catch.

### 3.6 What does not change

- **The stride is already derived from the declaration.** Engine #36 moved the
  writers from `MOTION_SIZE`/`BONE_SIZE` to `sizeof<MotionUpdate>()` /
  `sizeof<BoneUpdate>()` (`motion.ts:80`, `:112`, `bones.ts:145`). Because the
  nested `sizeof` is 64, the stride does not move — the two changes compose.
- **`layout_hash`.** The byte layout is identical and none of these records
  appears in `arena.rs`; the hash cannot move (§2). Assert it from both sides
  anyway when this lands.
- **The adapter.** It reads offsets it was given through `guest_read`; the
  offsets are unchanged.

### 3.7 An imprecision found while measuring

The declarations are commented "16 bytes, align 16" (`wire.ts:52`, `:61`, `:70`,
`:79`, `:88`) and `:457-459` says the 16-byte offsets come from "a record holding
a `Quatf` aligns that `Quatf` to 16". **Measured, that is not the mechanism**:
`alignof<Quatf>()` is **2** (log2 → 4-byte alignment), and the 16-byte placement
comes from the explicit `pad0: u64` (which ends exactly at 16) plus the
16-byte-sized fields striding naturally.

Nothing is broken — the offsets are right — but the *reason* in the comment is
wrong, and the reason is the thing the nesting work is deleting. Worth correcting
in the same PR so the next reader does not try to preserve an alignment that was
never there. If 16-byte alignment is genuinely required for a GPU upload, that is
a separate, real defect; it is not what makes these records 64 bytes.

Confirmed on three compilers 2026-10-28 (installed `@acakar` 0.9.0, published
`@yabgu_gm` 0.10.0, local `0b67e3cc`): `alignof` of a 16-byte plain struct whose
leaves are `f32` reports **2** (log2), i.e. 4-byte alignment — unchanged by the
flip, which moves `sizeof` and storage but not alignment. Whether that 4-byte
alignment is a defect for the GPU path is Phase 2's question (§3.8).

### 3.8 The TYPES verification — does `@abi.align(16)` move `layout_hash`?

§2 establishes that the five transform records are absent from `arena.rs`. But
`layout_hash` also folds `TYPES` (`arena.rs:442-453`), the nine protocol types'
`{id, size, align}` — and two of those entries are **anonymous literals**:

```rust
TypeEntry { id: 7, size: 64, align: 4 },
TypeEntry { id: 8, size: 16, align: 4 },
```

A 64-byte record at align 4 is the shape of `MotionUpdate`/`BoneUpdate`/
`Renderable`; a 16-byte one is `StringHalf`'s. If those two entries were transform
records, giving the transforms `@abi.align(16)` would move
`TYPES[id=7].align` from 4 to 16 and the hash with it — a coordinated release,
not a minor bump. **Verified 2026-10-28: they are not transform records.**

- **`id = 7` (size 64, align 4) is `Callbacks`.** `CALLBACKS_SIZE: usize = 64`
  (`arena.rs:457-459`) is declared immediately below the array, documented *"The
  `Callbacks` record's size, as the manifest pins it. `callbacks_len` in the open
  TLV must equal this."*
- **`id = 8` (size 16, align 4) is `Subscription`.** `SUBSCRIPTION_SIZE: usize =
  16` (`arena.rs:697-698`), documented *"as the manifest pins it (type 8)"* — the
  id is named in the source.
- **The generated guest table agrees, name for name.** `build.sh:201` regenerates
  `assembly/runtime/manifest.ts` from `arena.rs` on every build, and
  `scripts/gen-manifest.py` refuses on a count that is not 9, ids that are not
  1..9 ascending, or an order that disagrees with the guest's name list. The
  generated table (`manifest.ts:23-29`):

  ```
  ids    [1, 2, 3, 4, 5, 6, 7, 8, 9]
  names  [ArenaControl, SessionInfo, RegionDesc, ManifestEntry, TableHeader,
          StringHalf, Callbacks, Subscription, EventRecord]
  sizes  [256, 144, 24, 8, 32, 16, 64, 16, 32]
  aligns [8, 8, 4, 2, 8, 4, 4, 4, 4]
  ```

  `MotionUpdate`, `BoneUpdate`, `Renderable`, `Transformf`, `Aabbf` appear in none
  of those nine names, and `grep -c` for each in `arena.rs` is `0` (§2). The doc
  comment above `TYPES` states the rule that keeps it that way: *"the OGRE
  catalogue joins this table only when their shapes are pinned; adding an entry
  is a schema change, because it moves the hash."*

**Consequence — the hash does not move.** `@abi.align(16)` on the five transform
records touches nothing `layout_hash` folds: not the nine `_FIELDS` arrays, not
the region table, not `TYPES`. **0.11.0 stays a minor release**: no coordinated
release, no every-adapter-rebuilds step. The check was made by name rather than
by size precisely because the sizes collide — had those two literals been the
transform records, the answer would have been the opposite.

**What that also means.** The manifest compares **sizes only**, and only for the
nine ids (`arena.ts`, `manifestProblem`: the entry's `align` is not compared
against `alignof<T>()`). The transform records are not in the manifest at all, so
a change to their *alignment* is invisible to the runtime drift check. The
`offsetof` assertions in `wire.ts` are the only guard — which is why they must
stay load-bearing (§3.5) and the record bytes byte-identical (§3.6).

**Does `@abi.align(16)` move the offsets?** No — by arithmetic on the measured
layout, not by measurement of the feature: every transform field is a 16-byte
unit, every current transform offset is already 0 / 16 / 32 / 48, and every
current `sizeof` (64, 48, 32) is a multiple of 16, so rounding the record to a
16-byte alignment cannot move anything. What changes is what the record
*reports* (`alignof`) and where it lands when nested inside something else.
Phase 4 still proves it with the assertions and the byte compare; §3.2's offsets
are what the arithmetic is applied to.

---

## 4. Opportunity 2 — `Quat` becomes a value

### 4.1 The sites

`class Quat` (`assembly/anim/key.ts:36`, four `f32`) is GC-allocated at three
per-frame sites:

- `evaluator.ts:179-180` — `leftQ` / `rightQ`, per slerp, per joint, per frame.
- `animation.ts:247` — `keyAt`, per key decode.
- `key.ts:184` — one more in the decode path.

### 4.2 The `changetype` measurement — zero, so no migration

```
grep -rn "changetype<Quat>" tension-framework/assembly/   → 0
grep -rn "changetype<BoneTransform>" …                    → 0
```

Zero. A plain struct has no address, so `changetype<Quat>(ptr)` would refuse under
the flip — but no such site exists, so the conversion has no pointer-semantics
migration. That was the risk this measurement was for, and it is clear.

### 4.3 The real work: the out-parameter signatures

The conversion is not only a declaration change, because two APIs mutate a
caller-owned quaternion:

- `rotationAt(key: i32, out: Quat): void` (`animation.ts:228`)
- `unpackQuatInto(…)` (exported from `key.ts`)

A value type passes by copy, so `out` stops being an out-parameter. Both become
**returns**, which this compiler already supports (sret — a hidden destination
pointer, byte-verified in the compiler's own fixtures). That is a signature change
across the ~5 call sites listed in §4.1, not a mechanical rename, and it is why
this is a small commit rather than a cleanup.

### 4.4 The frame-time gate

**Measure before claiming.** Per-frame allocations are the plausible win, but
"plausible" is not a measurement:

1. Build and run **guest-motion** and **animated-character**, 300 frames each,
   on the pre-conversion compiler. Record: allocation count (the runtime's
   counter, not a grep) and frame time.
2. Convert.
3. Repeat on the post-conversion build.

**If the delta is under run-to-run noise, the CHANGELOG says "hygiene", not
"win".** If it is measurable, the number goes in the entry with the scene and the
frame count beside it. This is a gate on the claim, not on the change: the
conversion may land either way, but it may not be *described* as a performance
improvement without the two runs.

### 4.5 What this does not fix

`BoneTransform` (§5) is the dominant per-frame allocator — `identityPose`
allocates one per slot and `poseBuffer` re-allocates any null slot
(`evaluator.ts:59-76`). `Quat` is the small, unblocked half of the same problem.
Expect the `Quat` delta to be modest for that reason, which is exactly why §4.4
is a gate.

---

## 5. Opportunity 3 — `BoneTransform`: blocked

`class BoneTransform` (`key.ts:51`, 10 scalars) is the per-frame pose element:
`BoneTransform[]` throughout the evaluator (`identityPose`, `poseBuffer`,
`pose[slot]`, `poses: BoneTransform[][]`).

Converting it to a value needs `Array<@inline struct>`, which the compiler
**refuses by name** — an `Array<T>` holds its elements at `elementType` stride and
hands out references, so a value element would be stored inline in the heap with
copy-out reads. That is the deferred value-array design, not this plan.

Do not attempt it. When value arrays land, `BoneTransform` is the first
beneficiary and `identityPose` collapses to one allocation.

---

## 6. Opportunity 4 — sized enums: type safety, not bytes

**Measured, and the answer is no byte win.**

- **Zero** enum-typed record fields in the whole guest.
- **Zero** enum-typed arrays.
- All five enums (`LogLevel`, `AiRole`, `Kind`, `PadAxis`, `Renderer`) are
  **locals and parameters only** (`log.ts:69`, `:102`; `ai.ts:256`;
  `input.ts:111`, `:117`, `:217`; `ogre/index.ts:143`).

A narrower enum only saves bytes where an enum is *stored* — a record field or an
array element. Nothing stores one. Sizing them changes no layout, no stride, and
no allocation.

What sized enums *do* buy here is type safety: `enum Foo: u8` makes the width
explicit and the member range checkable. On `LogLevel` and `AiRole` that is worth
a small tidy; it is not a performance item, and it should not be described as one.

The wire records that carry `kind` / `state` / `flags` as `u32` are a different
question — shrinking a field moves the layout, and for the hashed records that is
forbidden outright (§2). That is the already-filed
`sized-enum-external-boundary` / `wire-records-with-sized-enums` work, and it
needs the C side measured first.

---

## 7. Opportunity 5 — the struct flip: no migration

**Zero plain `struct` declarations in the engine.** Every declaration is
explicit: **34 `@unmanaged`, 2 `@managed`** across
`assembly/ogre/wire.ts` (24), `assembly/runtime/wire.ts` (10),
`assembly/runtime/managed-alias.ts` (2).

So #38 changes nothing existing, and the framework guest compiles **byte-identical**
(200,098 bytes, `.wasm` and `.wat`) — verified when the flip landed.

The capability it unlocks is §3 and §4: guest-internal value types where nothing
allocates and no field is a pointer.

---

## 8. The order

**Phase 0 is a different repository and a different PR** (TensionScript); Phases
1–6 are this PR (#37). Phase 0's *version fix* has to land before Phase 1,
because Phase 1 installs what Phase 0 publishes. Phase 0's *`@abi.align(N)`
feature* has to land before Phase 4 — and only matters there if Phase 2 answers
yes.

| Phase | Step | Gate | Repo |
|---|---|---|---|
| **0** | **`@abi.align(N)` + the version fix.** Parser accepts the attribute post-type (the grammar `@abi.alias` already uses, `ast.ts:929` / `parser.ts:757`); the resolver threads it into the record's `alignLog2` (`resolver.ts:4073-4078`, `:4189`); the layout loop honours it. Then retitle the CHANGELOG's `## Unreleased — breaking` to `## 0.10.0`, add `## 0.11.0 — @abi.align(N)`, bump `package.json`, publish. | Published 0.11.0 compiles a fixture; an `@abi.align(16)` record reports `alignof` 4 (log2) with every `offsetof` unchanged | TensionScript |
| **1** | **Bump the engine to `^0.11.0`** and reinstall. Baseline first (§8.1). One version number in `tension-framework/package.json` and in the 6 `examples/*/package.json` that declare it — 9 example directories, 3 of them declare no compiler. | `npm ls @yabgu_gm/tensionscript` resolves to 0.11.0; guest `.wasm`/`.wat` `cmp` clean vs the baseline | Tension |
| **2** | **§3.7 measurement:** read the OGRE/GPU path for a 16-byte requirement on the transform records, and record §3.8's TYPES verdict. | An answer in writing, with the file and the line. If yes → the aligned shape is Phase 4's input; if no → the `wire.ts:457` comment is the only defect and `@abi.align` is not applied here | Tension (read-only) |
| **3** | **`Quat` → value** (§4) | The frame-time gate (§4.4) decides the wording, not the change | Tension |
| **4** | **Value twins + nested transform records** (§3), with `@abi.align(16)` **only if Phase 2 says yes** | Twins probe green; `offsetof` sums green; per-record bytes byte-identical; guest `.wat` byte-identical to pre-nesting; `layout_hash` unchanged | Tension |
| **5** | *(optional)* enum tidy on `LogLevel` / `AiRole` | Types only — no layout assertion moves | Tension |
| **6** | Verification, CHANGELOG, PR body | The four OGRE fixtures, `cargo test`, the hash from the host binary, one PR for review | Tension |

Phase 1 is the one that makes the rest safe: until the guest compiles identically
on the new compiler, nothing else can be attributed. Phases 3 and 4 are
independent and either may go first; 3 is smaller and self-contained, 4 is the
structural win.

**Phase 4 without Phase 0 is a supported outcome** — align-4 records, byte-
identical, `@abi.align` as a follow-up — provided Phase 2 measured that the GPU
path does not need 16.

### 8.1 The baseline, captured 2026-10-28

Measured in a worktree at `origin/docs/engine-adoption-plan` (`/tmp/engine-adopt`),
because the plan's own branch has no `node_modules` and the main checkout's
`build/index.wasm` is stale — it is 65,628 bytes dated Oct 26 18:43, i.e. built
**before** #36 (merged 19:05), so it cannot serve as a baseline for this tree.

```
npm install @acakar/tensionscript@0.9.0   # the compiler the tree shipped with
npm run build                             # 65627 bytes
npm install @yabgu_gm/tensionscript@0.10.0  # the published flip
npm run build                             # 65627 bytes
```

| Build | `.wasm` | md5 |
|---|---|---|
| 0.9.0 (pre-flip) | 65,627 | `a31897e114f21ac4eb7f588a373a8597` |
| 0.10.0 (published flip) | 65,627 | `a31897e114f21ac4eb7f588a373a8597` |

**Byte-identical, and the `.wat` too** (582,557 bytes). Two things follow:

1. **§7's claim is confirmed on the engine's actual tree**, not only on the
   compiler's own fixtures: the flip is a no-op for this guest.
2. **Phase 1's gate should compare against the 0.10.0 build, not the 0.9.0 one.**
   Both are saved (`/tmp/pre-bump-0.10.0.wasm`, `/tmp/pre-bump-0.10.0.wat`), and
   the 0.10.0 one is the right comparator: it differs from 0.11.0 by exactly the
   change under test, so a difference cannot be blamed on the flip. The 0.9.0
   comparison is the secondary claim — that the flip was a no-op — and it is
   already green.

**Builds are reproducible in place** (two runs, same directory, `cmp` clean), which
is what makes a byte comparison meaningful at all. Note the build is *not* proven
path-independent, so the Phase 1 comparison must run in one directory with only
the compiler changing.

**One number does not reconcile, and is flagged rather than fixed.** §7 records
the guest as 200,098 bytes. `npm run build` in `tension-framework` — whose entry
re-exports all eleven `assembly/*` modules, so it is the whole guest — produces
**65,627** bytes on this tree with the same 0.10.0 compiler. The plausible
explanations (a pre-#36 tree, a different entry, a different optimize level) are
not tested here. What the claim needed is not the number but the comparison, and
that is measured directly above: one tree, two compilers, md5-equal.

Declaration census, same tree: **34 `@unmanaged`, 2 `@managed`, 0 plain** (36
records), matching §7. (TensionScript's CHANGELOG says 35+2 = 37; the engine tree
counts 36. The 0-plain claim, which is what the flip's safety rests on, holds
under both.)

---

## 9. Not now

- **`BoneTransform` → value** — needs `Array<@inline struct>` (§5).
- **Renaming or reordering any hashed record** — 66 name-frozen fields across nine
  records; the hash folds the names (§2).
- **Sized enums on wire records** — moves the layout, and needs the C side
  measured first. Deferred, already filed.
- **16-byte alignment for the math records** — if it is a real GPU requirement it
  is its own defect; it is not what produces the current offsets (§3.7). The tool
  for it is Phase 0's `@abi.align(N)`, and applying it to the transform records
  does **not** move `layout_hash` (§3.8).

---

## 10. What could not be measured

- **`layout_hash` itself.** It is computed in Rust (`arena.rs:1030`) and
  `tension-core` was not rebuilt. What *is* verified is its composition (which
  records are name-frozen, which are absent) and that the guest bytes do not
  move for the changes proposed. The number is not asserted.
- **The engine's test suite.** `tension-framework/tests/run.sh` and
  `cargo test` were not run — they need the core built and, for the ogre scenes,
  a GPU-less path that is not wired up here. So "the guest compiles identically"
  is proven; "the engine behaves identically" is not.
- **The per-frame `Quat` cost** (§4.4) — no scene was run, so the win is
  unquantified by design, and the gate above is what closes it.
- **The C/adapter side of the nested records.** The offsets are unchanged and the
  adapter reads them through `guest_read`, but the adapter was not exercised.
- **Whether 16-byte alignment matters to the GPU path.** `alignof` is measured
  (log2 2, i.e. 4-byte — identical on 0.9.0, 0.10.0 and the local build); the
  consequence was not traced into the adapter. That is Phase 2's question, and it
  is the one open input to Phase 4.
- **`@abi.align` itself** — it does not exist in the compiler yet (`grep -rn
  "abi\.align" TensionScript/src` → **0** matches, 2026-10-28), so there is no
  measurement of the attribute to report. Phase 0 is what produces one.
- **`layout_hash` under `@abi.align(16)`.** The *composition* question is settled
  by name (§3.8: `TYPES[id=7]` is `Callbacks`, `[id=8]` is `Subscription`, no
  transform record appears), which is the half that decides whether the number
  *can* move. The number itself is still not computed here: `tension-core` was
  not rebuilt, so 786288195 remains an unasserted expectation rather than a
  measured value in this document.

---

## Appendix — probes

All compiled with TensionScript built from `0b67e3cc`, run under Node with a
standalone instantiation harness.

| Probe | Question | Result |
|---|---|---|
| twins | do the value and `@unmanaged` twins share a layout? | `sizeof` 16/16, `alignof` 2/2, offsets 0/4/8/12 and 0/12 — **identical** |
| nested-motion | is a nested `MotionUpdate` the same 64 bytes? | size 64/64, align 3/3, offsets 16/32/48 — **identical** |
| nested-renderable | same for the shape with no `pad0` | size 64/64, align 2/2, offsets 16/32/48 — **identical** |
| nested-write | do nested writes land where the flat record's did? | raw loads at 0/16/20/24/28/44/48 all correct (`run() = 127`) |
| `@inline`-on-field | does the field decorator make a field inline? | **no** — `sizeof` 32 with an `@unmanaged` inner, 64 with a plain inner |
| value-in-value nesting | can a plain struct nest a plain struct? | **refused by name** — `AS100 … SROA flattening, sub-phase B`; plain-inside-`@unmanaged` compiles (`sizeof` 24, `offsetof` 8) — both compilers |
| flip on the engine tree | does 0.10.0 change the framework guest? | **no** — 65,627 bytes, md5 `a31897e1…`, identical on 0.9.0 and 0.10.0 (`.wasm` and `.wat`, 2026-10-28) |
| TYPES ids 7/8 | are the anonymous entries transform records? | **no** — `Callbacks` (64/4) and `Subscription` (16/4), per `manifest.ts`'s generated names and `arena.rs:459`, `:697` |

Engine citations to `~/work/Tension` @ `9bf9ba1` (measured) and `4b42251` (this
branch's base; same tree). Compiler citations to TensionScript `origin/main` @
`0b67e3cc`, the published `0.10.0` tarball, and the installed `@acakar` `0.9.0`.
