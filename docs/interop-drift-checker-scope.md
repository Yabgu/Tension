# Follow-up A — the ABI drift checker

**Status:** scoping only. No source changed, no plan, no code. Stops here for the
architect before any design.

**Base:** Tension `origin/main` @ `a0c99f8` — *adopt: consume
`@yabgu_gm/tensionscript@0.8.1` and the interop surface (34 struct renames, 2 ABI
aliases)* (PR #29). Every citation is `path:line` at that commit, read with
`git show origin/main:<path>`; the working checkout was on `build/optimize-level`
with its own uncommitted build-work and was not touched.

**Method:** every claim below was measured from the tree at that commit — files
read, literals counted, history walked. Where the dispatch's premise does not
survive measurement it is stated in §0.1 rather than quietly dropped. Nothing
here was measured by running a compiler or a host binary; §13 lists exactly
what that leaves unverified.

---

## 0. The gap, precisely

`assertWireOffsets()` is 76 `offsetof` comparisons — 67 field offsets and 9
record-size relations, each against a literal
(`tension-framework/assembly/runtime/wire.ts:325-419`), each proving that the
declaration's computed offset equals a literal copied by hand from the host's
Rust constants. The filed follow-up states what that cannot prove
(`docs/interop-scope-addendum-2.md:629-633`):

> `assertWireOffsets()` proves *declaration == literal*, not *literal == host*;
> the framework check needs the host comparison.

`assertAbiAliases()` (`wire.ts:470-482`) is the same shape one step over: it
proves `abiNameOf<T>("class_")` equals the string `"class"` written in the same
file. It does not read anything from the host either.

So there are three facts in play, not two:

| fact | where it lives | checked against |
| --- | --- | --- |
| the declaration's offsets | `wire.ts` / `ogre/wire.ts` | a literal in the same file |
| the literal | the same file | nothing |
| the host's offsets | `arena.rs` constants | the declaration, indirectly, only through `layout_hash` |

`layout_hash` ties the *guest build* to the *host build* — a guest built against
a different shape is refused at `session_open` — but it does not tie the
declaration to anything, because the guest does not compute it. It copies a
scalar out of `session.json` (`build.sh:51-118`).

### 0.1 Corrections to the dispatch's premises

Four statements in the dispatch do not survive measurement. Each changes a
conclusion below, so they are stated here first.

1. **"If field names are not in the fold, a name drift would not move the
   hash."** They *are* in the fold. `layout_hash()` hashes `(name, offset)` for
   66 pairs across nine records (`arena.rs:1062-1081`), and the comment at
   `arena.rs:1063-1065` says so: "The *name* is hashed beside the offset, so a
   rename moves the hash as well as a move does." The hash covers the host's
   names; it does not cover the guest's. The root of the gap is therefore not
   name absence from the fold — it is that **the guest never computes the
   fold**.
2. **"A new session-open payload → the layout hash moves."** Not automatically.
   The adapter header is explicit: the hash "hashes arena geometry only … It
   does **not** cover this vtable", and a vtable change is enforced by
   `abi_version` alone (`tension-core/include/tension_adapter.h:80-96`). Only
   extending an *arena record* (e.g. `SessionInfo`) moves the hash. A new config
   key or a new export does not. §10 separates the cases.
3. **`tension_adapter.h` is not the host↔guest surface.** It is the C ABI
   between `tension-core` and a capability adapter (`tension_adapter.h:1-22`,
   `:78` for `TENSION_ADAPTER_ABI_VERSION 3u`). Its `layout_hash` is a
   load-time fingerprint checked when an adapter is `dlopen`ed
   (`tension_adapter.h:88-98`, `:434`). The host↔guest surface is the arena plus
   the `session` TLV (§2).
4. **SessionInfo "for months".** Measured: about **24 hours**. The guest's
   declaration was correct at `887164b` (2026-09-24, host `CLASS_COUNT = 10`,
   `SESSION_INFO_SIZE = 128`, nonce 88 — matching the guest's 10 capacities,
   128, 88). It went stale at `1ca1ced` (2026-10-21 02:22 +0200), the commit
   that took the host to `CLASS_COUNT = 13` / 144 / 104, and was corrected at
   `31a6626` (2026-10-22 02:50 +0200). One day, not months — which matters for
   the cost/benefit in §12, because a slow drift has more time to be found by
   other means.

A fifth, smaller correction: the dispatch says "141 offsetof sites". Measured at
this commit: **128** across the framework — 76 in `assembly/runtime/wire.ts` and
52 in `assembly/ogre/wire.ts`. `docs/interop-scope.md:318-320` measured 136 at
0.7.1 on an earlier base; the number has moved.

---

## 1. What `session.json` contains — measured

**File:** `tension-framework/session.json`, 293 bytes. Read by the generator at
`tension-framework/build.sh:51-118`, which emits
`assembly/runtime/layout.ts` and `build/session.asconfig.json` (`build.sh:5-27`).

Seven keys, no others:

| key | shape | value |
| --- | --- | --- |
| `abi_version` | int | `1` |
| `layout_hash` | int | `786288195` |
| `arena_size` | int | `6250528` |
| `max_arena_size` | int | `8388608` |
| `ring_capacities` | array of 13 ints | `[1,256,256,64,4096,4096,256,64,1024,256,16,16,16]` |
| `initial_pages` | int | `132` |
| `maximum_pages` | int | `512` |

**No field names appear anywhere in the file, and no per-field offsets.** The
generator requires exactly these seven keys and refuses a missing one
(`build.sh:71-79`); it refuses a `ring_capacities` array that is not 13 entries
(`build.sh:95-97`), checks the arena relations (`build.sh:83-107`), and refuses
a `--hash` that disagrees with `layout_hash` (`build.sh:110-116`).

What the guest actually compiles is `layout.ts`, generated from it
(`layout.ts:1,13-25`): `ABI_VERSION`, `LAYOUT_HASH`, `ARENA_SIZE`,
`MAX_ARENA_SIZE`, `MEMORY_BASE`, `INITIAL_PAGES`, `MAXIMUM_PAGES`,
`CLASS_COUNT = 13`, and `RING_CAPACITIES` — the same 13 ints, now as an array
the SDK iterates when it builds the open config (`config.ts:88-101`).

**Answer to the item that decides the checker:** session.json is a
**scalar-and-count manifest, not a schema**. It can support a count check
(13 classes, 13 capacities) and a hash comparison (already done). It cannot
support a name comparison, and it cannot support a per-field offset comparison —
neither is in it.

The one qualification: `ring_capacities`' *length* is a schema fact (the class
count), and it is already the thing that moved during the `SessionInfo` drift.

---

## 2. What the host sends at session open — measured

There are two directions, and neither carries a schema.

**Guest → host: the config TLV.** `session::open(cfg_ptr, cfg_len) -> i32`
(`tension-core/src/session/mod.rs:1158-1166`) reads a flat little-endian
key/value stream from guest memory. Keys (`session/config.rs:49-59`):

| key | meaning |
| --- | --- |
| 1 | `abi_version` (must be first) |
| 2 | `layout_hash` |
| 3 | `arena_size` |
| 4 | `max_arena_size` |
| 5 | `callbacks_ptr` |
| 6 | `callbacks_len` |
| `0x0100 + class` | `ring_capacity_<class>`, 13 classes |

Values are `i64` carriers (tag 2), keys outside `0x0100..=0x01FF` are ignored,
and `abi_version` / `layout_hash` are compared against the host's
(`config.rs:249-300`; `DESIGN.md:1682-1694`). The writer is
`ConfigBuilder.forThisBuild()` (`config.ts:88-101`), which states the generated
constants and all 13 capacities explicitly.

**Host → guest: no payload at all.** The host writes the arena *before*
instantiation — `prepare_arena` writes the control block, `SessionInfo`, the
region table, the manifest, and the canary lattice
(`session/mod.rs:500-541`) — and verifies it after instantiation, before the
guest's first instruction (`session/mod.rs:554-570`; called at
`main.rs:1215`). The guest reads those structures through `changetype<T>()`
views (`arena.ts:41-47`).

`SessionInfo` (`arena.rs:570-596`) carries, and only carries:

- `magic`, `abi_version`, `schema_version`, `flags`
- `arena_size`, `max_arena_size`, `memory_base`, `initial_pages`, `max_pages`
- `layout_hash` (one `u32`)
- `region_count`, `class_count`
- 13 capacities at 48..100 (`SESSION_INFO_CLASS_CAPACITY = 48`,
  `arena.rs:96`)
- `open_nonce` at 104 (`arena.rs:101`); record size 144 (`arena.rs:54`)

**No field names, no per-field offsets, no schema hash — one layout hash and
scalars.** The writer's own comment calls it "the cheapest drift detector there
is" (`arena.rs:567-569`): the session echoes its constants so a guest can assert
its own build against them. What the guest actually asserts is `layoutHash`
alone (`arena.ts:81-86`); it never reads `classCount` or the capacities
(`sessionInfo()` has three call sites: `arena.ts:45` the accessor, `:84`
`checkLayout`, `:124` `gapStart`'s `regionCount`).

**The one structure the guest does not read at all: the manifest.**
`prepare_arena` writes nine `{id, size, align}` entries at `MANIFEST_OFFSET`
(`arena.rs:442-452` `TYPES`; written by `write_manifest`, `arena.rs:620-630`,
called at `session/mod.rs:531`). `DESIGN.md:373-380` names the nine in order:
`ArenaControl`, `SessionInfo`, `RegionDesc`, the manifest entry itself,
`TableHeader`, `StringHalf`, `Callbacks`, `Subscription`, `EventRecord`. The
arena is the guest's own memory, so the guest can read them through
`ctrl().manifestOff` / `manifestLen` (declared at `wire.ts:118-119`, checked at
`wire.ts:335-336`). Nothing in the framework does: `grep manifest` over
`tension-framework/assembly` and `tension-ogre/assembly` finds only those
declarations and one comment.

This is the finding the rest of the scoping turns on: **a host→guest schema
channel already exists for nine record types, and it is unused.**

---

## 3. What the guest can export at session open — measured

**The host calls a fixed, small set of guest exports, and none of them is a
schema:**

| export | call site | required? |
| --- | --- | --- |
| `__start` | `main.rs:1225` | optional (`if let Ok(init)`) |
| `_start_game`, else `_start` | `main.rs:1331-1342` | one of them |
| `__taskWake` | `main.rs:1171` | optional, but paired |
| `__taskResume` / `__taskFail` | `main.rs:1174-1177` | optional |
| `_game_running` | `main.rs:1180` | paired with `__taskWake` |
| `table` | `session/mod.rs:1233` | needed for callbacks |
| `memory` | `main.rs:727,818,854` etc. | imported, re-exported |

The build sets `--exportTable`, `--exportStart __start`, `--importMemory`
(`build.sh:160-174`). There is no data export, no schema export, and no guest
function the host calls to ask about a type.

**So the guest only consumes.** `SessionInfo` and the manifest flow one way.
A guest→host schema would be a new mechanism, and the design space is:

- **(i) a new config key** carrying a blob (the `manifest` key
  `DESIGN.md:1705-1711` and `:2180-2184` already proposes: "the guest's own
  `{typeId, size, align}` table … would let the session walk the two catalogues
  and name the first type that differs"). Guest is the writer; the decoder is
  its strict reader (`config.rs:1-30`). No arena record changes.
- **(ii) a new wasm export** (a function returning a pointer/length, or an
  exported global naming a static table). The host already tolerates optional
  exports (`main.rs:1225`), so an old guest without it still runs.
- **(iii) an arena field**: extend `SessionInfo` or add a manifest entry. This
  is the case that moves `layout_hash` (§10).

Does (i) or (ii) "move the layout hash"? No: the fold reads arena geometry and
constants (`arena.rs:1030-1104`), and neither adds a region, a type entry, or a
field offset. What (iii) does is analysed in §10.

---

## 4. The `layout_hash` fold — measured

**Site:** `arena.rs:1030-1104`. Recorded value 786288195
(`arena.rs:1678`), pinned by `arena.rs:1783`.

Folded, in order:

1. header geometry: `REGION_COUNT`, `REGION_DESC_SIZE`, `MANIFEST_ENTRY_SIZE`,
   `TYPE_COUNT`, `HEADER_PAGE_SIZE`, `CONTROL_OFFSET`, `CONTROL_SIZE`,
   `SESSION_INFO_OFFSET`, `SESSION_INFO_SIZE`, `REGION_TABLE_OFFSET`,
   `MANIFEST_OFFSET`, `LAYOUT_FLOOR` (`arena.rs:1033-1045`);
2. the region table, 12 × `(kind, flags, size, align)` (`arena.rs:1048-1053`);
3. the type catalogue, 9 × `(id, size, align)` (`arena.rs:1056-1060`) — **no
   names** here;
4. **name then offset**, 66 pairs across nine records
   (`arena.rs:1062-1081`): `CONTROL_FIELDS` 15, `SESSION_INFO_FIELDS` 14,
   `TABLE_FIELDS` 7, `REGION_DESC_FIELDS` 6, `CALLBACKS_FIELDS` 5,
   `EVENT_FIELDS` 7, `STRING_HALF_FIELDS` 4, `SUBSCRIPTION_FIELDS` 4,
   `FRAME_STATE_FIELDS` 4 (`arena.rs:1106-1202`);
5. scalar constants: `CLASS_COUNT`, four modes, four states, four faults,
   `EVENT_RECORD_SIZE`, `RING_HEADER_SIZE`, the 13 default capacities
   (`arena.rs:1083-1101`).

So the hash covers host names, host offsets, sizes, and counts. **It does not
cover the guest's declarations**, because the guest never runs it: it carries
`LAYOUT_HASH` from `session.json` through `layout.ts` and compares it at open.
A field *rename* on the host side therefore moves the hash and a guest built
before it is refused — but that is caught by the build gate
(`build.sh:110-116`) and by `tension-core/tests/framework_layout.rs:55-92`,
not by anything in the guest. A field rename *in the guest* moves nothing.

**What this means for the dispatch's question 4:** adding field names to the
fold is not on the table, because they are already there. Two things are on the
table instead:

- **have the guest compute the fold** (the `interop-scope.md:366-380` option).
  That is the only way a name or offset drift inside `wire.ts` becomes visible
  to the guest's own check, and it is also the only option that would have
  caught `SessionInfo` from the guest side.
- **compare the existing fold differently** — a second, narrower hash over the
  guest's declarations only, carried over a new channel (§6 shape C).

The cost of the first is already scoped and it is a hash move: the guest would
have to reproduce FNV-1a over the host's canonical stream *byte for byte*,
including names it currently spells differently (§5), or it would not produce
786288195 and every guest would refuse to open. `interop-scope.md:366-380` calls
this "the 0.6.0a pattern — a coordinated release", and `:612-619` says the
recompute is a **no** until a drift-free declaration exists.

**Live evidence that text is not checked:** `arena.rs:15` and
`DESIGN.md:341` both still say `SessionInfo 128 B`, while
`SESSION_INFO_SIZE` is 144 (`arena.rs:54`) and has been since `1ca1ced`. The
prose drifted with the constant and nothing noticed, which is the same class of
bug as the guest declaration.

---

## 5. The alias surface — measured, and larger than two

**Declared aliases: two**, both on `class_`:

- `EventRecord.class_ : u32 @abi.alias("class")` (`wire.ts:244`)
- `Subscription.class_ : u32 @abi.alias("class")` (`wire.ts:305`)

**Asserted aliases: two**, plus one negative control, in one function
(`wire.ts:470-482`): `abiNameOf<EventRecord>("class_") == "class"`,
`abiNameOf<Subscription>("class_") == "class"`, and
`abiNameOf<EventRecord>("seq") == "seq"` (the fallback control). `abiNameOf` is
compile-time and folds to a constant (TensionScript `src/builtins.ts:1382-1454`
at 0.9.0); it has no host counterpart — `abi.alias` and `abiNameOf`
appear nowhere in `tension-core`.

**`@managed struct` aliases: 0.** There is no `@managed` declaration anywhere in
the Tension tree, and no fixture in TensionScript `origin/main` combines
`@managed` with `@abi.alias` (the managed fixtures are
`tests/compiler/interop/managed-struct*.ts`; every `@abi.alias` fixture is a
class or `@unmanaged struct`). Whether the combination compiles is **not
measured** here — TensionScript's local checkout is 0.8.1, and 0.9.0 is not
published, so no compiler on this machine accepts `@managed` (§13).

**The measured name surface is 34 of 66, not 2.** Comparing the host's 66
`(name, offset)` entries against the guest's declared field names, verbatim:

- **32 host names appear verbatim** in the guest (`magic`, `flags`, `head`,
  `tail`, `capacity`, `offset`, `length`, `kind`, `align`, `seq`, `a`, `b`,
  `f0`, `f1`, and the rest of the single-word fields).
- **34 do not.** Of those:
  - **2 are aliased** (the two `class_` fields).
  - **31 are camelCase ↔ snake_case**, and no alias records them:
    `abi_version`/`abiVersion`, `layout_hash`/`layoutHash`, `open_nonce`/
    `openNonce`, `frame_index`/`frameIndex`, `on_batch`/`onBatch`, … across
    `ArenaControl` (12), `SessionInfo` (11), `Callbacks` (4), `FrameState` (4).
  - **1 is a range**: the host has one entry `class_capacity` at 48
    (`arena.rs:1177-1190`), the guest has thirteen fields `capacity0..12`
    (`wire.ts:183-195`).

**Is any name asserted anywhere?** No. `assertWireOffsets` compares offsets
only. `assertAbiAliases` compares 2 strings that are both literals in `wire.ts`
plus one fallback control. The 32 verbatim names are asserted by nothing at all.

**This is the semantic model question, in numbers.** The guest's *spelling* is
not ABI — the wire carries no names, and `abiNameOf` returns the TypeScript name
except where an alias overrides it (TensionScript `builtins.ts:1436-1453`). The host's names
exist only to be hashed. So "the ABI name" is today one of:

- `class` for two fields (aliased, deliberate);
- `abi_version` on one side and `abiVersion` on the other for 31 fields (a
  convention, not a declaration);
- identical for 32 fields (also a convention);
- a 13-way expansion for one host entry.

A checker that compares names must first pick which of those is the truth. §8
is that decision, stated as a decision.

---

## 6. The three candidate shapes, with a fourth the dispatch did not list

Each is stated with what it catches, what it misses, what it needs, and whether
it moves the hash. Costs are in the units the dispatch asked for: ABI change,
adapter rebuild, hash move.

### Shape A — names only

Compare `abiNameOf<T>("field")` (the guest's declared ABI name) with the host's
name for the field at the same offset.

- **Catches:** a deliberate rename on either side; a wrong or missing alias; a
  field the guest calls something the host never had. In principle, the two
  `class_` cases if the alias were ever removed.
- **Misses:** everything positional — a field moved, a size changed, a field
  added or dropped with names intact. **It would not have caught `SessionInfo`:**
  every name it declares (`capacity0`..`capacity9`, `openNonce`) still exists;
  the count changed.
- **Needs:** the host's names in the guest. Today they exist only inside
  `arena.rs`'s hash tables and never leave the host (§2, §4). So: a new channel
  (§3 i/ii/iii) or a build-time dump.
- **Needs, second problem:** 31 fields disagree by convention before any check
  runs. Shape A either adds 31 aliases (turning a convention into 31
  declarations) or defines a normalization rule inside the checker — at which
  point the checker is checking a mapping it invented.
- **Hash move:** no for a config key or an export; yes if the names go into an
  arena record.
- **Verdict in one line:** the weakest shape per unit of cost, and it cannot
  catch the historical failure.

### Shape B — offsets/sizes only

Two granularities, and they have very different costs.

**B1 — type granularity (available today, zero ABI change).** The manifest
already carries `(id, size, align)` for nine types (`arena.rs:442-452`), and the
guest can read it (`ctrl().manifestOff` is the base, `wire.ts:118-119`; a
`changetype` view over the same memory the rest of `runtime/wire.ts` reads). Compare each against the value the declaration implies.

- **Catches:** `SessionInfo` 144 vs 128 — the exact historical failure. Also any
  record whose size or alignment changes. Nine of nine types covered.
- **Misses:** a field reorder inside a record, a rename, a field swap of equal
  width, and any record not in the manifest — **all capability records,
  including every OGRE wire record** (`DESIGN.md:373-380`: capability records
  are "deferred until the version pin").
- **Needs:** nothing new. Constants exist on both sides.
- **Caveat:** the id→type mapping is positional convention, not data
  (`arena.rs:442-452` lists ids 1..9 in order; `DESIGN.md:373-380` names them in
  the same order). The checker would encode that convention, so a type inserted
  mid-list would silently renumber the rest — worth naming before adopting.
- **Hash move:** none.

**B2 — field granularity (needs a channel).** Compare `offsetof<T>("f")` for
every field against the host's offsets.

- **Catches:** reorder, insertion, any single-field move — everything the
  hand-copied literals were supposed to catch, but against the host rather than
  a same-file literal.
- **Misses:** names (and the record's trailing extent, if not also compared —
  the size relations already in `wireOffsetsProblem` cover that).
- **Needs:** the manifest has no field offsets (`TypeEntry` is
  `{id, size, align}`, `arena.rs:432-437`). So: a new config key/blob, an
  export, or a generated table (§ Shape D).
- **Hash move:** none for a blob key; yes for an arena field.

### Shape C — schema hash

A canonical hash of `(name, offset, size)` per type, computed on both sides,
compared once.

- **Catches:** everything the existing fold covers, plus the guest's side of it.
  It is the only shape that catches a *rename* and a *reorder* in one integer.
- **Misses:** values that are not shape (already handled at open: capacities are
  compared by `config.rs`; `arena_size` relations by `build.sh:83-107`).
- **Needs (C1, derive the existing hash):** the guest reproduces FNV-1a over
  the host's exact byte stream — names in host spelling, the same field order,
  the same constants, and a size per record that AS 0.28 cannot supply from
  `sizeof` (`wire.ts:12-17` derives sizes from last-field + width instead).
  With 31 name-spelling differences unresolved, the guest's value would not be
  786288195; every guest would refuse to open.
- **Needs (C2, a separate hash):** a channel for the host's value plus the same
  naming agreement, but it need not equal `layout_hash` — so the failure mode
  is a named refusal from a new check, not a total open failure.
- **Hash move:** C1 as described is a hash move (all adapters, the 0.6.0a
  pattern, `interop-scope.md:366-380`). C2 moves no existing hash but adds a
  wire field.
- **Note:** the host already folds names, so C is the shape with the least new
  *semantics* and the most new *mechanism*.

### Shape D — build-time generation (not in the dispatch's three)

`tension-core` already answers `layout-hash` on stdout (`main.rs:528-534`). A
companion dump of the same constants — the records, their fields, their
literals — would let `tension-framework/build.sh` *generate* the right-hand
sides of `wireOffsetsProblem` instead of hand-copying them. The check stays
exactly where it is; the chain becomes *declaration == host* by construction,
because the literal came from the host.

- **Catches:** every offset, size and name the dump covers, forever — the copy
  step that produced the `SessionInfo` literal is removed.
- **Misses:** a guest that does not run the generator (a third-party guest with
  its own declarations), and the OGRE records unless the dump covers them too
  (they are adapter-side constants, not `arena.rs` ones — `tension-ogre/src/*.h`
  is the authority there).
- **Needs:** a host subcommand (a host-side addition with no wire change) and a
  generator change; no new import, no new export.
- **Hash move:** none — it only prints what `layout_hash` already folds.
- **Not measured:** whether the OGRE adapter's record offsets are expressible
  from the core binary at all (they belong to the DSO). That is an open cost.

---

## 7. `SessionInfo`, and the minimum information that would have caught it

**What happened, measured from history:**

| commit | date (+0200) | host | guest |
| --- | --- | --- | --- |
| `887164b` | 2026-09-24 | `CLASS_COUNT = 10`, size 128, nonce 88 | 10 capacities, size 128, nonce 88 |
| `1ca1ced` | 2026-10-21 02:22 | `CLASS_COUNT = 13`, size 144 (`arena.rs:54`), nonce 104 (`:101`) | **unchanged**: 10 capacities, nonce 88 |
| `31a6626` | 2026-10-22 02:50 | unchanged | 13 capacities, 144, 104 |

During the window the guest's own check passed: at `1ca1ced`,
`wire.ts:336-338` asserted `capacity9 == 84`, `openNonce == 88` and
`openNonce + 8 + 4*8 == 128` — all true of the stale declaration. The host, for
its part, had a test asserting the *relation*
`SESSION_INFO_CLASS_CAPACITY + CLASS_COUNT * 4 == 100`
(`arena.rs:1358` at that commit), which is why the host's own numbers stayed
consistent while the guest's did not. Nothing compared the two.

**Minimum information, in increasing order of cost:**

1. **The host's `SessionInfo` size (144).** It is already in the arena manifest
   as type id 2 (`arena.rs:442-452`), and the guest can read it with one
   `u16` load after `session_open`. The guest's declared size
   (`openNonce + 8 + 4*8` = 128) differs. **This alone catches the case.**
2. **`SESSION_INFO.classCount` (13) versus the generated `CLASS_COUNT` (13).**
   Also already available — the host writes it (`arena.rs:586`), the guest
   generates the constant (`layout.ts:21`), and the guest reads neither today.
   This catches the *count* half directly, and it is a single comparison.
3. **The relation `[capacity array] == CLASS_COUNT entries`.** This is the one
   the host test at `1ca1ced` used and the guest never had. It needs no host
   data beyond `CLASS_COUNT`, which is generated into `layout.ts`.
4. **The host's nonce offset (104).** Not in the manifest (the manifest carries
   sizes and alignments, not field offsets). Needs shape B2.

So the **minimum information is a number that already crosses the boundary**:
type id 2's size, or the class count. The failure was not caused by missing
information; it was caused by the guest not reading what it was given. That is
the single most important finding in this scoping, because it puts a real check
inside the zero-cost column.

**What that minimum still misses:** any drift that preserves a record's size and
alignment — a `u32` swapped with another `u32`, a field renamed, two same-width
fields reordered. For those, only B2 or C is enough (§6), and both need
something new.

---

## 8. Do we check names if names are not ABI? — the decision, stated

The dispatch asks this directly, and the measurement makes it sharper than
"2 aliases versus 70 OGRE decoder names".

**What is established:**

- The wire carries no names. A guest reads bytes at offsets; a C adapter reads
  its own struct at its own offsets. Neither side transmits an identifier.
- The host's names are hashed (`arena.rs:1062-1081`) but never transmitted. A
  rename is a host-side hash event, caught at build by the hash gate, not a wire
  event.
- The guest's names are a source-level convenience; `abiNameOf` returns them
  verbatim unless an alias overrides (TensionScript `builtins.ts:1436-1453`).
- `@abi.alias` is consumed by exactly one builtin and by no host code.

**So there are two coherent semantic models, and they are not compatible:**

- **Names are documentation.** Then a name checker is checking prose, the 2
  aliases are lint, and the checker should be offsets/sizes only (shape B or D).
  The OGRE ruling is already this model for decoder-local names
  (`wire.ts:456-462`): "the wire bytes carry no field names at all … aliasing
  them would record an implementation detail as protocol metadata".
- **Names are ABI** (they identify a field to a human reading a dump, a
  debugger, or a future reflective tool). Then the alias set is not 2 — it is 33
  (34 differences minus the one range), and the 31 camelCase/snake_case pairs
  are today's *undeclared* ABI names. Adopting that model means either adding
  31 aliases (each one a declaration both sides must honour) or declaring a
  normalization rule (e.g. compare case-insensitively after stripping `_`),
  which is not free either: `class_`→`class` survives it, but the rule becomes
  protocol.

The middle position — check the 2 aliases and nothing else, as
`assertAbiAliases` does — is the one that exists today, and it is coherent only
under the first model: it is a lint that the annotation mechanism works, not a
drift check.

**This scoping does not pick.** It reports that shape A and shape C are
downstream of this decision, and that shapes B and D are not.

---

## 9. Where the check runs — four options, tradeoffs, no pick

**1. In the guest, at open.** Every guest runs it after `session_open`, in
`assertWireOffsets`' slot.

- For: the arena is present, the manifest is readable, comparisons fold to
  constants, no ABI change for B1/D, no build-pipeline change.
- Against: it only protects guests that call it. Measured: **no example calls
  `assertWireOffsets` or `assertAbiAliases`** (`git grep` over `examples/` → 0);
  the runtime checks are called by two test guests
  (`tests/guest-open.ts:48` and `:51`, `tests/guest-ogre.ts:77`) and by seven OGRE test
  guests for `assertOgreWireOffsets`. Unless the SDK's own open path calls it,
  the check ships nowhere — the same fate as today's.
- Also against: a third-party guest's own records are its own; only the SDK's
  declarations are covered.

**2. In the framework's test harness.** A witness or fixture guest prints its
derived schema; the harness compares it to the host's.

- For: no runtime cost, no wire change, runs where the drift was found, and the
  harness already builds and runs guests against the real host
  (`tension-framework/tests/run.sh:1-55`), while `framework_layout.rs` already
  ties the three hash carriers. The pattern exists.
- Against: covers only what the fixture declares (the SDK's `wire.ts`, the OGRE
  wire). A user's guest is not covered. Runs on `cargo test` cadence, not on
  every build.

**3. Host-side, at `session_open`.** The host compares the guest's schema to its
own before going READY.

- For: the strongest place — the host holds the truth, the refusal is named, and
  it covers every guest that opens a session.
- Against: **requires the guest's schema to reach the host**, which is the new
  channel (§3). That is the only option that changes the ABI.
- Against, second: it makes every guest pay the wire cost forever, including
  guests that would rather not.

**4. At compile time (TensionScript).** The compiler checks declarations against
a host-provided manifest.

- For: the earliest possible failure, and it would cover every guest that
  compiles.
- Against: there is no manifest today. `tension-core layout-hash` prints one
  number (`main.rs:528-534`); nothing dumps a schema. This option is really
  shape D plus a dependency from the compiler to the host binary — a much
  larger coupling than the dispatch's framing suggests, and it crosses the repo
  boundary the 0.8.0/0.9.0 work just finished tidying.

**What does not depend on the choice:** the manifest's nine sizes/alignments and
`classCount` are already on the correct side of the boundary. Options 1 and 2 can
use them today; options 3 and 4 cannot use them at all without a channel.

---

## 10. Version boundary — naming the cost of each side

The dispatch's framing ("host-side → hash moves → 0.6.0a") is half right. The
header says which half (`tension_adapter.h:80-96`): the hash covers arena
geometry, the vtable is governed by `abi_version` alone.

| change | hash moves? | `abi_version`? | adapters rebuilt? | 0.6.0a pattern? |
| --- | --- | --- | --- | --- |
| guest-side check against the existing manifest + `classCount` | no | no | no | no |
| build-time generator (shape D) | no | no | no | no |
| new config key (guest writer, host reader) | no | no | no | no |
| new optional wasm export | no | no | no | no |
| extend `SessionInfo` (or add a manifest entry) | **yes** | no | **yes** | **yes** |
| new `tension_core_api` / vtable field | no | **yes (3→4)** | **yes** | no |

A hash move means: `session.json`, `layout.ts`, `tension_adapter.h`'s macro
(`tension_adapter.h:98`), `RECORDED_LAYOUT_HASH` (`arena.rs:1678`), and every
built guest and adapter move together — the coordinated release
`interop-scope.md:366-380` describes as "all 16 consumers plus two DSOs". An
`abi_version` bump refuses every adapter built against 3 at load
(`tension_adapter.h:88-96`), which is a rebuild, not a hash move.

**So the cheap side of the boundary is bigger than the dispatch assumed:** three
of the four mechanisms (existing manifest, build-time generation, config key,
export) cost neither a hash move nor an adapter rebuild. Only *extending an
arena record* pays the 0.6.0a price, and the manifest design deliberately
avoided that by deferring capability records to a schema bump
(`DESIGN.md:373-380`).

---

## 11. What forces a no

Three conditions, each measured here:

1. **Names are wanted as ABI, and neither 31 aliases nor a normalization rule is
   acceptable.** Then shapes A and C are out, and what remains (B/D) is not a
   name checker. The honest answer is "no name checker", not a weak one.
2. **A checker that re-hand-copies offsets.** If the only implementable version
   of B2 is a second list of literals in another file, it reproduces the defect
   one level up: it proves *new literal == declaration*, and the new literal is
   as stale-able as the old. It must be generated (D) or read from the arena.
3. **A host-side check that needs an arena-record extension for a nine-type
   check the arena already supports.** Extending `SessionInfo` when the manifest
   already carries sizes is paying the 0.6.0a price for redundancy.

Two conditions that do **not** force a no, contrary to the dispatch's list:

- **"session.json has no field names and the host cannot export them"** —
  true for names, but the checker's most valuable case does not need names, and
  the count and size it does need are already exported (§7).
- **"The semantic model is ambiguous"** — it is ambiguous only for the
  names-checking shapes. Sizes and offsets have one meaning and two carriers.

---

## 12. Recommendation: proceed — narrowly, and with a decision the architect owes

**Proceed, but not with the dispatch's three shapes as listed.** The measured
information says the highest-value check is the one that needs no new channel,
and the dispatch's three shapes all assume one.

Recommended direction, stated as shape not plan:

- **Primary: B1 at type granularity, in the guest, at open** — compare the
  manifest's `(size, align)` for the nine pinned types, and
  `SessionInfo.classCount` / the capacity count, against the declaration. Zero
  ABI change, zero hash move, zero adapter rebuild, and it catches the one
  failure this follow-up exists for. It should be called from the SDK's open
  path, not from a fixture, or it ships nowhere (§9, option 1).
- **Secondary: D (build-time generation)** to remove the hand-copied literals
  that made `SessionInfo` possible. This is the structural fix, and it is
  already the disposition addendum-2 filed: "whether the guest's literals should
  be generated from the host rather than hand-copied"
  (`interop-scope-addendum-2.md:213-221`).
- **Defer A and C** until the architect answers §8. Both are downstream of
  "are names ABI", and both require a channel that B1/D do not.

**What B1 does not buy, stated plainly:** it catches size and alignment drift
and count drift. It does not catch a same-size reorder inside a record — which
is exactly the class of bug the hash was widened to catch on the host
(`DESIGN.md:350-360`). If the architect wants that on the guest side, the answer
is C2 (a separate schema hash over a new channel), and it should be scoped on
its own.

**Cost if B1 is chosen and the hash never moves:** no rebuild, no release
coordination, no `session.json` edit. **Cost if any arena record is extended:**
the 0.6.0a pattern, named in §10, for a check the manifest already serves.

**The decision the architect owes:** does an ABI name exist? If yes, the alias
surface is 33, not 2, and shapes A/C become possible; if no, the 2 aliases are
lint and the checker is offsets/sizes. This scoping cannot settle it from the
tree, because the tree does not decide it — `abiNameOf`'s own comment says an
alias is "metadata the other side of the ABI may use"
(TensionScript `builtins.ts:1384-1391`), which is a third position: names may be ABI for
someone, but that someone is not in this repo.

---

## 13. What could not be measured read-only

- **Whether `@managed struct` accepts `@abi.alias`.** No `@managed` declaration
  exists in Tension; TensionScript's local checkout is 0.8.1 and 0.9.0 is not
  published (`npm view` → 0.8.1), so no compiler here accepts it. Stated as 0
  aliases, not as 0 possible.
- **Whether an AssemblyScript guest can reproduce `layout_hash()` exactly.**
  This is the C1 cost; it was not built. The obstacles are visible in tree
  (name spelling, FNV byte order, `sizeof` unusable on these records) but their
  total is not measured.
- **Whether the manifest's `{size, align}` for a type actually equals what the
  guest's declaration would compute.** The host's values are constants
  (`arena.rs:442-452`); the guest's are derived from `offsetof`. No comparison
  was run, because that is the checker.
- **Whether `tension-core` can dump the OGRE adapter's record offsets.** The
  OGRE records are adapter constants (`tension-ogre/src/scene.h:103-160`), not
  `arena.rs` ones, so shape D's coverage there is a hypothesis.
- **Runtime behaviour of any check.** No compiler, no host run: this scoping
  measured files, literals, and history only.

---

## 14. Citation index

**Tension `origin/main` @ `a0c99f8`**

- `tension-framework/session.json` — 7 keys, 13 capacities, no names
- `tension-framework/build.sh:51-118` — generator, refusals, hash gate;
  `:95-97` the 13-class check; `:160-174` `asc` flags
- `tension-framework/assembly/runtime/layout.ts:13-25` — generated constants
- `tension-framework/assembly/runtime/wire.ts:12-17` — why `sizeof` is unusable;
  `:118-119` manifest accessors; `:158-205` `SessionInfo`; `:244`, `:305`
  aliases; `:325-419` the 76 offset checks; `:440-445` `assertWireOffsets`;
  `:447-482` `assertAbiAliases` and the alias rationale
- `tension-framework/assembly/runtime/config.ts:88-101` — `forThisBuild`
- `tension-framework/assembly/runtime/arena.ts:41-47,81-86,120-131` —
  `sessionInfo`, `checkLayout`, `gapStart`
- `tension-framework/assembly/ogre/wire.ts:811-936` — OGRE checks (52
  `offsetof`)
- `tension-core/src/session/mod.rs:500-541` — `prepare_arena`;
  `:554-570` `verify_post_instantiate`; `:1158-1166` `session_open`
- `tension-core/src/session/arena.rs:15` (stale 128 B comment); `:47,54,96,101`
  `SessionInfo` constants; `:124` `CLASS_COUNT`; `:266` defaults; `:432-452`
  `TypeEntry`/`TYPES`; `:539` control block; `:570-596` `write_session_info`;
  `:620-630` `write_manifest`; `:1030-1104` `layout_hash`; `:1062-1081` the
  name+offset fold; `:1106-1202` field tables; `:1678` recorded value;
  `:1783` pinning test
- `tension-core/src/session/config.rs:49-59,249-300` — the TLV keys and decoder
- `tension-core/src/main.rs:528-534` `layout-hash`; `:1171-1180` task exports;
  `:1215` arena verification; `:1225` `__start`; `:1331-1342` `_start_game`
- `tension-core/include/tension_adapter.h:1-22,78,80-98,434` — the adapter ABI,
  and the hash-not-vtable rule
- `tension-core/tests/framework_layout.rs:55-92` — the three hash carriers
- `docs/interop-scope.md:318-320` (call counts at 0.7.1); `:348-362` (§4, the
  drift and what the hash covers); `:366-380` (derive-the-hash cost)
- `docs/interop-scope-addendum-2.md:196-221` (the filed follow-up A text);
  `:629-633` (the restated follow-up)
- `tension-ogre/DESIGN.md:338-380` (header map, manifest, what the hash covers);
  `:1682-1711` (config keys and the manifest-blob future work);
  `:2180-2184` (the same, restated)
- `tension-ogre/src/scene.h:103-160` — the adapter's record structs
- history: `887164b` (2026-09-24), `1ca1ced` (2026-10-21), `31a6626`
  (2026-10-22)

**TensionScript `origin/main` @ `277eebaf`** (read only, for the alias surface)

- `src/builtins.ts:1382-1454` — `abiNameOf`; `:1436-1453` the alias fallback
- `tests/compiler/interop/abi-alias.ts`, `tests/compiler/interop/managed-struct*.ts`
  — no fixture combines `@managed` with `@abi.alias`
