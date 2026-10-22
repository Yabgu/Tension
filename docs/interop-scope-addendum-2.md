# Interop phase — scoping addendum 2

**Status:** third scoping pass. Read-only. No source changed, no plan, no code.
**Base:** the same tree as `docs/interop-scope.md` and
`docs/interop-scope-addendum.md` — TensionScript `next` @ `50cceb36`, package
`0.7.1`; Tension `main` working tree.
**Relationship to the prior documents:** both stand as written and neither was
modified. This document closes the one measurement the second pass left as an
inference (Item 1) and records four items the review owes the record (Items 2-5).

**Method note.** Item 1 is measurement only: a file read, a generator
extraction, and a regeneration into `/tmp` (never into the repo). Items 2-5 are
records; where a record depends on a fact, the fact is cited to a file:line.

**Item 1's answer in one line: none of the three SessionInfo quantities is
encoded in `layout.ts`, measured; the phase does not split.**

---

## Item 1 — the `layout.ts` SessionInfo citation, closed

### The file, and its generator

- **Path:** `tension-framework/assembly/runtime/layout.ts` — 26 lines, the
  file named at its own line 1 as generated.
- **Generator:** `tension-framework/build.sh`, visible read-only. The Python
  template is `build.sh:120-145`; it is invoked at `build.sh:51` with four
  arguments — `session.json`, the `layout.ts` output path, the asconfig output
  path, and an optional `--hash` (`build.sh:51-56`).
- **Its only input:** `tension-framework/session.json`. The template
  (`build.sh:120-145`) interpolates only `cfg[...]` values and locals derived
  from them — `arena`, `ceiling`, `initial`, `maximum`, `len(caps)`, `caps` —
  and the file's key set is
  `abi_version`, `layout_hash`, `arena_size`, `max_arena_size`,
  `ring_capacities`, `initial_pages`, `maximum_pages` (measured). No key names
  a `SessionInfo` field, an offset, or a size.
- **It never reads the declarations.** `build.sh` contains no reference to
  `wire.ts` or to anything under `assembly/` except the two paths it creates and
  writes (`build.sh:49`, `:51`).

The complete content of the generated file, so nothing is taken on trust:

```
15  export const ABI_VERSION: u32 = 1;
16  export const LAYOUT_HASH: u32 = 786288195;
18  export const ARENA_SIZE: u32 = 6250528;
20  export const MAX_ARENA_SIZE: u32 = 8388608;
21  export const MEMORY_BASE: u32 = 8388608;
22  export const INITIAL_PAGES: u32 = 132;
23  export const MAXIMUM_PAGES: u32 = 512;
24  export const CLASS_COUNT: u32 = 13;
26  export const RING_CAPACITIES: u32[] = [1, 256, 256, 64, 4096, 4096, 256, 64, 1024, 256, 16, 16, 16];
```

### The three fields, present or absent

| # | quantity | guest | host | in `layout.ts`? | citation |
|---|---|---|---|---|---|
| a | `openNonce` offset | 88 | 104 | **absent** | `grep -n -i "nonce"` over the file → 0 hits; `grep -n "\b88\b\|\b104\b"` → 0 hits |
| b | capacity count | 10 | 13 | **absent as a layout encoding**; the number 13 appears at `layout.ts:24` (`CLASS_COUNT`) and as the length of the array at `:26`, both derived from `session.json`'s `ring_capacities`, not from the declaration | `layout.ts:24`, `:26`; `build.sh:143`, `:145` |
| c | `SessionInfo` size | 128 | 144 | **absent** | `grep -n "\b128\b\|\b144\b"` → 0 hits |

On (b), the distinction is worth stating precisely because a bare "13 is
present" would be misleading: `CLASS_COUNT` is the number of event classes
(`arena.rs:124`), and `RING_CAPACITIES` is the per-class capacity list
(`arena.rs:266-267`); both are properties of the *session*, not of the
`SessionInfo` record's field layout. The guest's declaration says ten capacities
(`wire.ts:175-184`) and the host says thirteen (`arena.rs:96`, `:587-592`);
`layout.ts` says neither — it says 13 because there are 13 classes.

### The causal chain the review asked about

The review's hypothetical was: *fixing the guest's declaration changes
`layout.ts`, which changes the fold input, which moves the hash.* The chain is
broken at two independent links, and both are measured.

**Link 1 — the fix does not reach the generator.** `layout.ts` is generated from
`session.json` (`build.sh:51`), and `session.json` is not derived from the
declarations. A corrected `SessionInfo` declaration in
`tension-framework/assembly/runtime/wire.ts:159-192` would change that file, its
check literals at `wire.ts:324-338`, and nothing else in the generator's input
set. **Empirical proof:** the generator was extracted from `build.sh` and re-run
against the committed `session.json` into `/tmp/genout/`; the produced
`layout.ts` is **byte-identical** to the committed one (`diff` → no output).
`layout.ts` is a pure function of `session.json`, and `session.json` does not
change.

**Link 2 — the fold does not read `layout.ts` at all.** `layout_hash()`
(`arena.rs:1030-1104`) takes no arguments and reads no file; every input is a
Rust `const` or a table of them (the line-by-line inventory is in
`docs/interop-scope-addendum.md`, Item 2). A grep of `tension-core/src` for
`layout.ts` yields exactly one hit, a comment in `main.rs:530`. The only code
that parses `layout.ts` is a **test**
(`tension-core/tests/framework_layout.rs:61`, `:123`), and it reads four
values from it — `LAYOUT_HASH`, `ARENA_SIZE`, `MAX_ARENA_SIZE`, `MEMORY_BASE`
(`:64`, `:124-126`) — none of which is a `SessionInfo` field. No Rust file
references `wire.ts` (`git grep "wire\.ts" -- 'tension-core/src/*.rs'
'tension-core/tests/*.rs'` → 0 hits). The two hits under `tension-core` are
comments in a C test stub, and they are a *third* hand-copy of a layout worth
recording: `tests/support/ogre_stub_adapter.c:24-32` restates the `Job` record
field-by-field (`0 job_id, 4 state, … 56 reserved2 → 64 bytes`) and says it
mirrors `ogre/wire.ts`. It is test scaffolding, it is not folded into the hash,
and it is another place a field move must be applied by hand.

So even in the counterfactual where `layout.ts` did encode the record, the fold
would not move; and in the actual file it does not encode it. The second pass's
conclusion was reached from "the fold reads Rust constants only", which was
true; the review correctly asked whether the *generated file* carried the
declaration through. It does not.

### Verdict for Item 1

**Measured, not inferred: fixing the guest's `SessionInfo` declaration moves no
hash.** `SESSION_INFO_SIZE` (144), `SESSION_INFO_CLASS_CAPACITY` (48) and
`SESSION_INFO_OPEN_NONCE` (104) are folded at `arena.rs:1042`, `:1190` and
`:1191` respectively, from host constants that do not change. The host's value
is `786288195`, reproduced in the second pass and re-checked by the host binary
in this pass.

The second pass's reworded clause stands as written, and is now measured rather
than argued: *the host's hash never depended on the guest's declaration.*

**The phase does not split on this account**, and no coordinated release is
implied by C. The full edit surface of the correction is framework-local:
`wire.ts:159-192` (the declaration) and `wire.ts:334-338` (its check literals);
nothing in `tension-framework/assembly` reads `SessionInfo`'s size or its
capacity array — the only consumer outside the check block is
`arena.ts:124`, which reads `regionCount` at 40 and agrees in both shapes
(measured: `grep -rn "offsetof<SessionInfo>\|sizeof<SessionInfo>\|sessionInfo()\."`
returns the check block plus that one line).

---

## Item 2 — the working-tree compiler divergence check

**What the role asked about, and what exists.** The dispatch names
`~/work/as-inspect/assemblyscript` as the clone implementation will run against.
That path **does not exist**: `/home/acakar/work/` contains only `Tension`
(measured). So the re-run against it was not possible, and no claim is made
about it.

**What was done instead — the diff check, which is possible and stronger.**
The published package ships a source map whose `sourcesContent` carries the
original compiler sources: `@acakar/tensionscript@0.7.1`'s
`dist/assemblyscript.js.map` lists 49 sources including `../src/program.ts`,
`../src/types.ts`, `../src/builtins.ts` and `../src/compiler.ts`, with content.
Those were extracted to `/tmp/interop-probe/pubsrc/` and diffed against
`third_party/assemblyscript/src/` (version `0.7.1`, commit `50cceb36` —
both measured from `package.json` and `git log`).

| file | exercised by the fixture for | result | sha256 (first 16) |
|---|---|---|---|
| `src/builtins.ts` | `sizeof`, `alignof`, `offsetof`, `load`, `store` | **identical** | `121b9d508bcf0b33` both |
| `src/program.ts` | class type construction, class ids | **identical** | `9838641c2a7851ad` both |
| `src/types.ts` | `byteSize`, `isMemory` | **identical** | `8364a88b744e335e` both |
| `src/compiler.ts` | field-access codegen, `module.load/store` | **identical** | (diff → no output) |

A recursive diff of the entire std tree (`/tmp/interop-probe/node_modules/@acakar/tensionscript/std`
against `third_party/assemblyscript/std`) produced **no differences**
(`diff -r -q` → empty, exit 0). That covers `std/assembly/string.ts` and the
runtime that the fixture's `--runtime incremental` links.

**What this establishes.** The compiler the Item 1 fixture ran (published
0.7.1) and the tree's checkout are the same sources on every file, not merely
on the exercised paths. A fixture result measured against one is a fixture
result for the other.

**What this does not establish.** It says nothing about
`~/work/as-inspect/assemblyscript`. If implementation runs against that clone
and it has diverged, this check would not detect it.

**Unable to run.** The tree's own compiler cannot be executed read-only:
`third_party/assemblyscript/dist/` contains `asc.d.ts`, `assemblyscript.d.ts`,
`transform.cjs`, `transform.d.ts`, `transform.js` and no `asc.js`
(measured), so there is no built CLI in the checkout, and building one would
write into `third_party/` — forbidden by `AGENTS.md` rule 1. The published
package's `dist/asc.js` is what ran the fixture.

**Status to record:** *diff check done (tree ≡ published 0.7.1, byte-identical
on the four exercised compiler files and the whole std tree); `as-inspect`
absent, so the re-run against it is an architect item before implementation
if that clone is to be the build compiler.*

---

## Item 3 — the `assertWireOffsets` coverage gap

**Measured callers** (grep over the tree, `node_modules` excluded):

| check | callers | where |
|---|---|---|
| `assertWireOffsets()` (session runtime) | **2** | `tension-framework/tests/guest-open.ts:42`, `tension-framework/tests/guest-ogre.ts:77` |
| `assertOgreWireOffsets()` (OGRE wire) | **7** | `tension-ogre/tests/guest-light.ts:301`, `guest-angular.ts:248`, `guest-motion.ts:179`, `guest-hierarchy.ts:112`, `guest-skinning.ts:189`, `guest-render-check.ts:166`, `guest-procedural.ts:121` |
| `assertOgreMotionOffsets()` | **2** | `tension-ogre/tests/guest-motion.ts:180`, `guest-skinning.ts:190` |
| `assertOgreBoneOffsets()` | **1** | `tension-ogre/tests/guest-skinning.ts:191` |
| **examples** (anything that ships) | **0** | `grep -rn ... --include=*.ts examples` → 0; the only two hits in `examples/` are README prose (`ogre/hello-mesh/README.md:63`, `ogre/hello-triangle/README.md:60`) |

**Correction to the second pass.** The second pass said "only the framework's
two test guests call the check". That was measured within
`tension-framework/tests` and is true there; a tree-wide sweep also finds seven
`tension-ogre` test guests. The substantive claim is unchanged and is what the
record needs: **the checks are exercised only by test guests, never by an
example a user runs.**

**Why the gap matters, stated as a property rather than an absence.** Each check
is `offsetof<T>("field") != <literal>`. The left side is computed from the
declaration; the right side is a literal copied by hand from the host's layout.
The check therefore proves *declaration == literal*. It cannot prove
*literal == host*, and nothing in the guest can. The `SessionInfo` drift is the
demonstration: the declaration says `openNonce` at 88 and the check at
`wire.ts:337` asserts 88 — the check passes, and the host says 104.

**Filed follow-up (not a fix, not a proposal):**
> **Interop follow-up A — the offset checks do not ship.** The session runtime's
> `assertWireOffsets()` is called by two test guests
> (`tension-framework/tests/guest-open.ts:42`, `guest-ogre.ts:77`) and by no
> example; the OGRE checks by seven test guests and no example. Every check
> compares a declaration against a hand-copied literal, so a check can pass
> while both are wrong about the host (the `SessionInfo` case). Filed for
> decision: whether any shipping guest should call the check, and whether the
> guest's literals should be generated from the host rather than hand-copied.

---

## Item 4 — the "half-working test shape" note

**The note, recorded.** This phase produced two cases of a shape that deserves a
name, and the second is the one that is new:

- The `break`/`continue` phase had a **half-working fix**: the partial change
  passed the obvious cases and hung on `for`+`continue`
  (`docs/async-complete.md:153-158`). The middle state was a program.
- This phase had a **half-working observation**: a probe consistent with the bug
  it was meant to detect, but also consistent with the absence of the bug. The
  prior "load copies" claim came from `store<T>(dst, rec); load<T>(dst).b` — a
  pointer round trip, in which `load` returns an address that field access then
  dereferences correctly. It reads as a successful copy and is not one.
  Measured on the real host in the second pass:
  `store<Two>(dst, rec)` → `dst = 0x10`, `load<Two>(dst).b = 0xdeadbeef`;
  `store<Two>(dst, load<Two>(src))` → `dst = 0x1`, `.b = 0x0`.

**The rule it yields, stated as a sentence:** *an observation that is consistent
with the bug it is meant to detect is not a measurement; a fixture must contain a
cell that fails under the bug and passes without it, or it proves nothing.* The
distinguishing cell here is a record written field-by-field at a fresh address,
`load<T>`-ed from **that address**, reading the **second** field
(`docs/interop-scope-addendum.md`, Item 1).

**Filed update (not applied — `docs/async-complete.md` was not modified):**

> **Interop follow-up B — `docs/async-complete.md` corrections.** The paragraph
> at `docs/async-complete.md:87-101` (menu item 1) states three things that
> measurement has since corrected:
>
> 1. **`:97-98`** — "`store<T>(ptr, value)` writes **one word** — while
>    `load<T>(ptr)` correctly copies the data". `load<T>` does not copy: it is a
>    one-word load, and the claim's origin is a pointer round trip
>    (`docs/interop-scope-addendum.md`, Item 1; re-measured on the real host).
> 2. **`:92`** — "**39 wire types already use it**". The measured count is **33
>    `@unmanaged` declarations** (24 `ogre/wire.ts` + 9 `runtime/wire.ts`); 39 is
>    the count of decorator *lines*, six of which are comments
>    (`docs/interop-scope.md`, §5).
> 3. **`:93`** — "`offsetof<T>("field")` … in 75 places". The measured count is
>    **135 call sites** (73 in `runtime/wire.ts` + 62 in `ogre/wire.ts`) plus
>    three comment mentions (`docs/interop-scope-addendum.md`, Item 5).
>
> The update also belongs with menu item 5 (Docs, `:105-106`), which the
> `store<T>` deferral depends on (below).

The deferred `store<T>` documentation dependency, restated in one sentence so it
is not lost between documents: **the named copy is the struct copy until 0.8.0,
`store<T>` silently writes one word for an `@unmanaged` record, the compiler
does not refuse it, and the only guard is the Docs item**
(`docs/interop-scope-addendum.md`, Item 4).

---

## Item 5 — boundaries, each as a sentence

1. **Map/Set runtime paths are out of scope for the named copy.** The collateral
   that a `sizeof` semantics change would create in `std/assembly/map.ts:43-44`
   and `set.ts:41` belongs to that 0.8.0 semantics change, not to the named
   copy, which adds a function and changes no intrinsic.
2. **The `f64` payload cell is deferred to the three-way fixture.** The Item 1
   fixture used `i32` fields, and the `f64` second-field cell is carried by the
   three-way fixture (`docs/interop-scope.md` §6.4) rather than re-run here.
3. **The host build used in Item 1 was debug, not release.** The fixture ran on
   `tension-core/target/debug/tension-core` with no session and no adapter — a
   real-backend run, satisfying the discipline note, but a debug-profile host,
   and that build configuration is recorded as a fact.
4. **Inline fixed-size scalar arrays are not expressible, and that is a
   C-interop boundary.** `@unmanaged class A { data: f32[4] }` is a parse error
   (`ERROR TS1005: ']' expected`, measured), the closest spellings are
   references (`offsetof<A>()` = 4), and the workaround the tree uses is manual
   field expansion — `Mat4f` is sixteen `f32` fields
   (`tension-framework/assembly/ogre/wire.ts:81-85`) — which is a known
   limitation for C-shaped structs, not a zero-cell footnote.
5. **Struct-in-struct has no inline form, and pointer nesting is handled
   correctly by pointer semantics.** Inline containment is not expressible;
   `@unmanaged class Outer { inner: Inner }` compiles as a 4-byte pointer
   (`offsetof<Outer>("inner")` = 4, `offsetof<Outer>()` = 12, measured), so Q8's
   containment exclusion is moot for the inline case and satisfied for the
   pointer case, because a `memory.copy` of `offsetof` bytes copies that pointer
   and nothing else.
6. **The 51 stores are disjoint from the 135 call sites, and no array payload is
   possible by construction.** `bones.ts`, `motion.ts` and `skin.ts` contain 51
   `store<…>` calls and zero `offsetof<` calls (measured), no declaration among
   the 33 has an array-typed field (Item 5 sweep, category b = 0), and therefore
   `memory.copy(dst, src, offsetof<T>())` is the correct copy for every record
   the tree can express.

---

## What could not be run or located

- **`~/work/as-inspect/assemblyscript`** — absent. `/home/acakar/work/`
  contains only `Tension`. The re-run against it was not attempted and no claim
  is made about it. The diff check in Item 2 covers tree ≡ published 0.7.1
  only.
- **The tree's own compiler** — not runnable: `third_party/assemblyscript/dist/`
  has no `asc.js` (measured), and building one would write into `third_party/`,
  which `AGENTS.md` rule 1 forbids.
- **Regenerating `layout.ts` in place** — deliberately not done; the generator
  was extracted and run into `/tmp`, and the result diffed against the
  committed file (identical).
- **`tension-core` layout-hash under a modified host** — the perturbation
  experiment in the second pass was a Python replication, and the host binary
  was run unmodified in both passes (`786288195`, re-confirmed here). No host
  build was altered.

---

## Appendix — this pass's raw outputs

**Item 1, the file's complete content:** `cat -n` of
`tension-framework/assembly/runtime/layout.ts` → 26 lines, quoted above in full.

**Item 1, greps over that file:**

```
grep -n -i "sessioninfo\|session_info\|nonce\|capacity\|capacities"
  → 25:/** Per-class ring capacities, in class-id order. */
    26:export const RING_CAPACITIES: u32[] = [1, 256, …];

grep -n "\b88\b\|\b104\b\|\b128\b\|\b144\b\|\b48\b"
  → (no output)
```

**Item 1, generator inputs:** `grep -n "wire\|assembly/" build.sh` → the
`assembly/runtime/layout.ts` comment (`:6`), the `mkdir` (`:49`), and the
`python3` invocation (`:51`). No read of any declaration file.

**Item 1, regeneration:**

```
$ python3 /tmp/gen_layout.py tension-framework/session.json \
      /tmp/genout/layout.ts /tmp/genout/session.asconfig.json ""
==> wrote /tmp/genout/layout.ts
==> wrote /tmp/genout/session.asconfig.json

$ diff /tmp/genout/layout.ts tension-framework/assembly/runtime/layout.ts
(no output — identical)
```

**Item 1, fold independence from the file:**

```
$ grep -rn "layout.ts" tension-core/src --include=*.rs
src/main.rs:530:        // the generated `layout.ts` carry it, and this is where it comes from
$ git grep -n "wire\.ts" -- 'tension-core/src/*.rs' 'tension-core/tests/*.rs'
(no output)
$ git grep -n "wire\.ts" -- tension-core
tension-core/tests/support/ogre_stub_adapter.c:25: (a comment; the Job mirror)
```

**Item 2, the diff:**

```
$ diff -q /tmp/interop-probe/pubsrc/src__builtins.ts   third_party/assemblyscript/src/builtins.ts
$ diff -q /tmp/interop-probe/pubsrc/src__program.ts    third_party/assemblyscript/src/program.ts
$ diff -q /tmp/interop-probe/pubsrc/src__types.ts      third_party/assemblyscript/src/types.ts
$ diff -q /tmp/interop-probe/pubsrc/src__compiler.ts   third_party/assemblyscript/src/compiler.ts
(all four: no output)

$ diff -r -q node_modules/@acakar/tensionscript/std third_party/assemblyscript/std
(no output, exit 0)

sha256: builtins 121b9d508bcf0b33… both; program 9838641c2a7851ad… both;
        types 8364a88b744e335e… both
```

**Item 3, callers:** the table above; examples → 0 hits.

**Item 5, the stores and the sweep:** `store<` counts 15/30/6 in
bones/motion/skin; `offsetof<` 0/0/0; `Array<WireType>` and
`StaticArray<WireType>` → 0 for all 33 names.

---

## Fourth pass — the implementation records

Four sentences the implementation phase owes this record, written before the code
change that follows them.

**1. The compiler of record.** Every compile-output and runtime claim in this
implementation uses the **published `@acakar/tensionscript@0.7.1`**
(`dist/asc.js`), not the tree's checkout, because two things are absent:
`~/work/as-inspect/assemblyscript` does not exist (`/home/acakar/work/`
contains only `Tension`), and `third_party/assemblyscript/dist/` has no `asc.js`
(measured: it contains `asc.d.ts`, `assemblyscript.d.ts`, `transform.cjs`,
`transform.d.ts`, `transform.js`). Building one would write into `third_party/`,
which `AGENTS.md` rule 1 forbids. The published compiler and the tree's sources
are byte-identical on the four exercised files and the whole std tree (Item 2),
so the fixture's compiler is the tree's compiler.

**2. Follow-up: a third hand-copy of a layout.**
`tension-core/tests/support/ogre_stub_adapter.c:24-32` restates the `Job`
record field by field (`0 job_id, 4 state, 8 kind, 12 flags, 16 priority,
20 resource_id, 24 progress, 28 error, 32 name_offset, 36 name_length, 40 seq u64,
48 reserved u64, 56 reserved2 u64 → 64 bytes`) and says in its own comment that
it mirrors `tension-framework/assembly/ogre/wire.ts`. It is **test scaffolding**,
it is not folded into `layout_hash()`, and it is **recorded, not fixed** by this
phase. *Lettering note:* this addendum already used "Follow-up A" (the offset
checks do not ship) and "Follow-up B" (`docs/async-complete.md` corrections), so
this item is **Follow-up C** in the record; the implementation prompt called it
"B", and the intent is the same.

**3. Two hand-copies remain after phase C** (the `SessionInfo` correction). The
guest's `SessionInfo` is fixed by this phase; what remains uncorrected, and
recorded rather than fixed, is (i) `tension-core/tests/support/ogre_stub_adapter.c`
above, and (ii) the OGRE host's decoded records at
`tension-ogre/src/scene.h:103-145`, which mirror `wire.ts` field for field — the
`MaterialRecord` there declares one texture slot (`scene.h:128`) where the guest
declares eight (`ogre/wire.ts:305-312`). `layout.ts` is **excluded by
derivation**: it is a pure function of `session.json` (measured — regenerated
byte-identically), so it carries no record layout to drift.

**4. Item 2's check was a sourcemap proxy, not a re-run.** The compiler-divergence
check behind sentence 1 extracted the published package's
`dist/assemblyscript.js.map` `sourcesContent` and diffed it against
`third_party/assemblyscript/src/`. It is strong evidence (byte-identical on
`builtins.ts`, `program.ts`, `types.ts`, `compiler.ts`, and the whole std tree)
but it is **not** an execution of the tree's checkout. A re-run against the tree
requires a writable clone and a built `dist/asc.js`; that is an architect
decision, not a scoping one.

**5. The `store<T>` deferral is in force after this phase.** `store<T>` stays a
one-value (reference) store for an `@unmanaged` `T`; the named copy is the struct
copy; and `store<Record>(slot, record)` still compiles and still writes one word.
The compiler does not refuse it until 0.8.0. **Docs (menu item 5) owns the note**
(`docs/async-complete.md:105-106`); this phase files it and does not edit that
file.

**6. The three-way fixture, measured on the real host.** The named copy's cells
are green (Table: cell 1 broken, cell 2 partial, cell 3 fixed). Two corrections
to the plan, both measured: `offsetof<Mixed>()` for
`{a:i32; b:f64; c:i32}` is **20** (a@0, b@8, c@16), not the 16 the plan stated;
and an **unaligned** destination does not corrupt in wasm — a full-size
`memory.copy` to `dst + 1` preserved all three fields, because wasm scalar
loads/stores carry no alignment requirement. The partial state that actually
ships is therefore a **granularity** bug (a word-at-a-time loop that drops the
tail), not an alignment bug, and that is the cell-2 shape used below.

| cell | shape | result on `tension-core` (real host, `--runtime incremental`) | verdict |
|---|---|---|---|
| 1 broken | `memory.copy(dst, src, sizeof<T>())` | `Two{a=1,b=0xDEADBEEF}` → `a=1 b=0x0` | **LOST** — the gap is real |
| 2 partial | `offsetof<T>()` but word-granular (`u64` loop) | `Mixed{a=1,b=2.5,c=3}` → `a=1 b=2.5 c=0` | **TAIL LOST** — the half-fix ships this |
| 2 note | `dst + 1`, full size | `a=7 b=9.25 c=11` | survived; no alignment failure exists |
| 3 fixed | `memory.copy(dst, src, offsetof<T>())` | `a=1 b=2.5 c=3`, `compare(20)=0`, `compare(32)=-170` | **correct, exactly 20 bytes** |

Emitted widths (`threeway.wat`): cell 1 is `i32.const 4; memory.copy`; cell 3 is
`i32.const 20; memory.copy`; cell 2 is an `i64.load`/`i64.store` loop bounded by
`i32.const 20`, so its last four bytes are never reached.

---

## Fifth pass — the struct phase, implemented

**Compiler of record for this pass.** The canonical checkout was provisioned at
**`/home/acakar/work/as-inspect/assemblyscript`** (clone of
`git@github.com:Yabgu/TensionScript.git`, `main` @ `50cceb36`, package `0.7.1`),
built with `npm ci` + `npm run build`; `dist/asc.js` exists there now. Its
sources are byte-identical to the vendored snapshot on the six exercised files
(`src/builtins.ts`, `src/program.ts`, `src/types.ts`, `src/compiler.ts`,
`std/assembly/util/bytes.ts`, `std/assembly/task-rt.ts`). **A pristine build of
this checkout reproduces the published 0.7.1 compiler byte-for-byte**: compiling
`tension-framework/tests/guest-flow.ts` with the rebuilt pristine `dist/asc.js`
and with the published `dist/asc.js` gives the same `sha256` (`c54d1c9e…`). That
supersedes the sourcemap proxy of addendum-2 Item 2 with an execution.

### Items 1-2 — the std half, in the canonical checkout (not published)

| item | file:line | change | evidence |
|---|---|---|---|
| 1 | `std/assembly/util/bytes.ts:108-135` (declaration at `:133`) | `COPY_STRUCT<T>(dst, src)` = `memory.copy(dst, src, offsetof<T>())`, beside `REVERSE` (`:1`) and `FILL` (`:56`) | compiles; `@inline`, no `@unsafe` (an `@unsafe` decorator would make a guest call fail under `--noUnsafe` — `src/compiler.ts:6479-6493`) |
| 2 | `std/assembly/task-rt.ts:130,132` | `RECORD_PAYLOAD`/`RECORD_F0` derive from `offsetof<TaskRecord>("payload")` / `("f0")` instead of the literals 8 and 16 | measured against the real declaration: 8 / 16, record size 32 |

**Correction to the scoping (item 2's end state).** `docs/interop-scope.md`
§6.5 said these two constants "become `offsetof<TaskRecord>(…)`", and the
implementation prompt said "field access". **Field access cannot express the
64-bit arm.** `__taskCompleteResult<R>` (`task-rt.ts:575-583`) stores a generic
`R` — `i64`/`u64`/`f64` — which lands across `f0`/`f1`, *two declared `f32`
fields*; `record.f0 = value` cannot write eight bytes there. The end state is
therefore **`offsetof`-derived constants**, which is strictly better than the
hand-coded literals (they cannot drift from the declaration) and is the maximum
this pattern allows. `RECORD_PAYLOAD` keeps the same spelling as its sibling for
symmetry, not because it needs the offset form. No field access was attempted.

**Item 2 is a codegen no-op, measured.** Six async fixtures compiled with the
published compiler and with the modified one, from the same working directory:
`guest-push`, `guest-flow`, `guest-drop`, `guest-early`, `guest-chain`,
`guest-sync` — **byte-identical wasm** for all six. (An earlier apparent
difference was a working-directory artefact: the compiled-in source path.)

**Delivery path, real backend** (`tension-core/target/debug`, `--runtime
incremental`), all exit 0:

```
guest-push   PUSH parked, _start_game returning / PUSH resumed with 2
guest-early  EARLY resumed with 6 (buffered before the park)
guest-flow   FLOW PASS  (while+break 3, while+continue 9, for+continue 9, for+break 406)
guest-drop   DROP woke with status -5 (-EIO)
```

**Compiler suite:** 1218 `SUCCESS`, 2 `FAILURE` — `async-closures-case6` and
`async-closure-value` (fixture mismatch). **Both reproduce on the pristine
checkout** (stash → re-run → same two names), so they are the standing red, not
this change. `npm run test:async` fails identically on pristine
(`tests/async/lower.js:241`, `TypeError`).

**Not published.** `npm whoami` → `E401 need auth`; no `NPM_TOKEN`, no
`~/.npmrc`. The release (and therefore the vendored-snapshot refresh and the
framework's dependency bump) **cannot be done in this session** and is not
claimed. The std change sits in the canonical checkout, uncommitted, waiting for
a maintainer with publish rights.

### Item 3 — `wire.ts` (as reported; unchanged since)

`SessionInfo` → 144 B, 13 capacities, `openNonce` 104; check literals likewise.
Compiled offsets 144/104/96; `checkWireOffsets()` PASS on the real host;
`tests/guest-open.ts` against a live arena prints OK, exit 0; `layout-hash` →
**786288195**; `cargo test --test framework_layout` 3 passed.

### Item 4 — field assignment, 45 of 51 sites

**Correction to the implementation prompt** (the scoping stands): item 4 is
**field assignment**, not the named copy — `docs/interop-scope.md` §8 D:
"`bones.ts`, `motion.ts`, `skin.ts` become field assignment on the existing
declarations." These are per-frame writers into arena slots; a source record
would be an allocation per call.

| file | sites | target type | `@unmanaged`? | citation |
|---|---|---|---|---|
| `ogre/bones.ts:137-158` | 15 stores → 15 field writes | `BoneUpdate` | **yes** | declared `@unmanaged` at `ogre/wire.ts:488-489` |
| `ogre/motion.ts:76-96` (`set`) | 15 → 15 | `MotionUpdate` | **yes** | `ogre/wire.ts:461-462` |
| `ogre/motion.ts:110-130` (`setPose`) | 15 → 15 | `MotionUpdate` | **yes** | same |
| `ogre/skin.ts:87-92` | **6 remain raw** | *none exists* | — | see the gap below |

**The offsets and widths are unchanged, measured.** Old `#write` emitted
`base + {0,4,8,16,20,24,28,32,36,40,44,48,52,56,60}` with widths
`i32,i32,i64,f32×12` written as `i32.add` + bare store. New `#write` calls the
generated setters, each of which is `f32.store offset=16`-style — the same
offsets and widths, with the constant folded into the store immediate. Both were
read out of the `--target release` WAT.

**Finding 2 — the instruction pattern changed, measured.** 15 inline stores
became 15 calls to 3-instruction setters; the probe grew **6924 → 7085 bytes
(+161)**. The compiler emits accessor calls for class-field assignment at
`--target release`, measured also for a class and its writer in the *same*
module, so it is not an artefact of module boundaries — it is the compiler's
shape, not the code's. Both a setter and a getter are three instructions with the
offset folded into the immediate:

```
BoneUpdate#set:positionX   local.get $0 / local.get $1 / f32.store offset=16
ArenaControl#get:state     local.get $0 / i32.load   offset=160
```

**The read path does the same** — `ctrl().state`, `sessionInfo().regionCount`
and `regionDesc(k).offset` each emit a `call` to a three-instruction getter
(measured, `readpath.wat`, `--target release`) — so there is **no read/write
asymmetry**: field access through `changetype<T>` costs one call in both
directions, and that is the tree's accepted idiom (`arena.ts:41-71`,
`rt.ts:98-100`), not a regression this phase introduced. §8 D's "zero-allocation"
claim is true (no allocation in any of the 45 writes); the **instruction** cost
is what §8 D did not measure, and it now is: **15 accessor calls per
`BoneBatch.write`, 15 per `MotionBatch.set`, 15 per `MotionBatch.setPose`, on a
per-frame path.** Filed as follow-up G.

**Real OGRE verification** (`tension-core` + `tension-ogre/build/libtension_ogre.so`,
`TENSION_OGRE_HEADLESS=1`, NULL render system, `--runtime incremental`). The
fixtures that assert these very offsets all pass:

| fixture | result | what it asserts |
|---|---|---|
| `guest-motion` | **5/5** | `MotionBatch.setPose` / `set` wire offsets through the adapter |
| `guest-skinning` | **6/6** | `BoneBatch` offsets |
| `guest-angular` | **8/8** | `BoneBatch`, rolling contact |
| `guest-physics` | **9/9** | motion table end to end |
| `bouncing-bodies` (real example, 300 frames) | exit 0, `asleep 43/64`, KE 0.0221 | `MotionBatch` at `game.ts:191` |

**Finding 1 — `animated-character` is a smoke test, not evidence.** The
implementation prompt named it "the adopter"; the measurement says otherwise: it
uses `ogre.SkinMatrixBatch` (`game.ts:350`), and `skin.ts` is the one file not
converted. It ran (300 frames, 4 characters, exit 0) and is recorded as a
**smoke test**. The **evidence** for item 4 is the four fixtures whose assertions
*are* these offsets: `guest-motion` 5/5, `guest-skinning` 6/6, `guest-angular`
8/8, `guest-physics` 9/9. `bouncing-bodies` (300 frames, exit 0, `asleep 43/64`)
is a second smoke test — it exercises `MotionBatch` (`game.ts:191`), so it is a
weaker but real signal, and it is recorded as a smoke test, not as evidence.

### The `skin.ts` gap — reported, not invented

`skin.ts:87-92` writes a 32-byte table entry (`SKIN_SIZE`, `wire.ts:746`) whose
shape exists only as six `store<…>(at + N)`: `renderableId@0`, `used@4`,
`bytes@8`, `flags@12`, `reserved u64@16`, `reserved u64@24`. **No `@unmanaged`
declaration of that record exists** — `SkinMatrixBatch` (`skin.ts:55`) is the
managed batch object, not the arena entry. §8 D says "field assignment on the
existing declarations"; there is none here, so converting means *creating* a
wire type — the new-surface case the scoping assigned to a separate phase for
`input.ts` (§8 E). Left raw, and filed:

> **Interop follow-up E — the skin table has no declaration.** `skin.ts:87-92`
> writes six fields of a 32-byte record with no `@unmanaged` type to name it.
> Decide: declare `SkinEntry` in `ogre/wire.ts` (new wire surface, and the first
> use of the phase's pattern on a record the guest *writes*), or leave raw.
> Until then the 51-store count is 45 converted + 6 waiting.

### Filed, not applied

> **Follow-up A (restated)** — `assertWireOffsets()` proves *declaration ==
> literal*, not *literal == host*; the framework check needs the host comparison.
> Item 3 made the literals right for `SessionInfo`; the structural gap stands.
>
> **Follow-up C** — `tension-core/tests/support/ogre_stub_adapter.c:24-32` is a
> third hand-copy of a layout (the `Job` record). Test scaffolding, recorded, not
> fixed.
>
> **Follow-up D** — `tension-framework/tests/run.sh:55` sets
> `asc="$framework/node_modules/.bin/tensionscript"`, and that path does not
> exist: the framework's `node_modules` holds upstream `assemblyscript@0.28.20`
> (its bin is `asc`, not `tensionscript`). **The framework's own test suite has
> not run under TensionScript in this session** — the fixtures were compiled
> directly with the canonical compiler instead. Note it; do not fix it here.
>
> **Follow-up E** — `skin.ts:87-92` writes a 32-byte table entry
> (`SKIN_SIZE`, `wire.ts:746`) that has **no declaration**: six raw stores
> (`renderableId@0`, `used@4`, `bytes@8`, `flags@12`, `reserved u64@16`,
> `reserved u64@24`). `SkinMatrixBatch` (`skin.ts:55`) is the managed batch
> object, not the arena entry. Item 4 therefore converted **45 of 51** sites;
> the remaining 6 wait on a decision to declare the record — new wire surface,
> which §8 E reserves for a separate phase. **Not invented here.**
>
> **Follow-up F — closed, by measurement.** The question was whether the read
> path inlines while writes emit calls. Measured (`readpath.wat`, `--target
> release`): `ctrl().state`, `ctrl().sessionNonce`, `sessionInfo().regionCount`
> and `regionDesc(k).offset` each emit `call` to a three-instruction getter
> (`local.get`/`load offset=N`). **Both directions emit calls**, so the pattern
> is consistent and item 4's cost is the tree's accepted idiom, not an
> asymmetry. Nothing left to decide.
>
> **Follow-up G — compiler accessor inlining for `@unmanaged` field access.**
> Field access through `changetype<T>` emits a call to a generated
> getter/setter, even at `--target release` and even within one module (measured
> both ways). That is a compiler limitation, not a design flaw in the converted
> code. File for 0.8.0-adjacent work: measure whether the compiler can inline
> field access on `@unmanaged` types in both directions, and whether the
> `changetype` pattern is the blocker. **Do not fix in this phase.** It may be a
> 0.7.x optimisation rather than 0.8.0 scope — the measurement decides, not this
> note.
>
> **Follow-up H — `COPY_STRUCT` has no consumer yet.** Item 4 used field
> assignment and item 2 used `offsetof`-derived constants, so nothing in the
> tree calls the helper. It is a **std primitive added ahead of consumption**,
> not dead code: its first consumer is Follow-up E's phase (or any future
> struct copy). Recorded so a later reader does not delete it as unused.
>
> **Follow-up I — the compiler suite's two failures, named.** They are
> `async-closures-case6` and `async-closure-value`, both **`[fixture mismatch]`**
> (the checked-in `.wat` no longer matches what the compiler emits). Verified
> pre-existing: stashing both std edits and re-running the same two tests
> reproduces them exactly (`npm run test:async` also fails identically on the
> pristine tree, `tests/async/lower.js:241`, `TypeError`). Suite totals with the
> edits in place: **1218 `SUCCESS`, 2 `FAILURE`**. Recorded so future readers
> know the red is not theirs.
>
> **`store<T>` migration note (Docs owns it)** — `store<T>` is a reference
> store; `COPY_STRUCT<T>` is the struct copy; `store<Record>(slot, record)` is
> not refused until 0.8.0. Docs (menu item 5) carries it.

### Item 4's form — accepted, and why

Field assignment stays; the "keep the raw stores" alternative is rejected. The
phase's purpose is to eliminate hand-coded offsets, and keeping them would
defeat it. The accessor cost (Finding 2) is **recorded, not hidden**, and the
pattern already exists on the tree's read path, so this is consistency rather
than a new idiom. The real remedy is the compiler (Follow-up G), not a retreat
to literals.

### Version boundary, restated

- **Items 1-2** (std: `COPY_STRUCT` in `util/bytes.ts`, the `offsetof`-derived
  constants in `task-rt.ts`) — need a **TensionScript release**. The canonical
  checkout's change is **uncommitted and unpublished**: that is the maintainer
  handoff, not this session's task (no credentials). Registry verify after
  publish: `npm cache clean --force` + `npm view --prefer-online` + a direct
  `curl` with `Cache-Control: no-cache`.
- **Items 3-4** (framework: `runtime/wire.ts`, `ogre/bones.ts`,
  `ogre/motion.ts`) — land on **TensionScript 0.7.1**. They consume neither
  `COPY_STRUCT` nor the derived constants, so they are **independent of the
  TensionScript release**; the framework can move to the new TensionScript later,
  when it exists.
- **0.8.0 remains reserved** for `sizeof` semantics, the `store<T>` refusal and
  `T[N]`. Follow-up G is 0.8.0-*adjacent* — possibly a 0.7.x optimisation — and
  is not 0.8.0 scope as filed.
