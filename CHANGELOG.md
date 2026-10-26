# Changelog — the Tension tree

Repo-level. One file for the whole tree (`tension-framework`, `tension-core`,
`tension-ogre`, and the capability crates beside them): the guest SDK, the
interpreter and the adapters are released together, because an adapter is built
against the arena's shape hash and a guest is compiled against it, so a version
line per directory would only ever move in lockstep. Per-crate extraction is
deferred until the tree splits release cycles, and that split would be the reason
to do it, not a reason to do it now.

Entries are dated rather than numbered: Tension does not version independently
of TensionScript today (the guests' compiler is `@yabgu_gm/tensionscript`, pinned
in `tension-framework/package.json`), so there is no Tension version number to
attach a change to.

---

## 2026-10-26 — Framework record writers: the stride comes from the declaration

### Field assignment is confirmed on main, and the stride now derives from it

`bones.ts` and `motion.ts` write their records with `@unmanaged` struct field
assignment — `changetype<BoneUpdate>(slot).positionX = x` — not with hand-coded
`store<u32>(at + 16, …)`. That conversion is PR #26's (`31a6626`), and it is on
`main`; a checkout showing raw stores there is pre-#26 (the report that prompted
this change was read from `build/optimize-level`).

The two write paths multiplied by `BONE_SIZE` / `MOTION_SIZE` to find the slot.
They now multiply by `sizeof<BoneUpdate>()` / `sizeof<MotionUpdate>()`, so the
stride and the field offsets both come from the one declaration. `BONE_SIZE` and
`MOTION_SIZE` stay exported — they are the wire's published stride, and the
region arithmetic, `PROCEDURAL_BASE` and the physics fixture still read them.

**Byte-identical at `-O3`.** `tension-framework`'s `index.wasm` is
`ff42c221527bacfaf3215d6610402586`, 65 628 bytes, before and after; the wat is
byte-identical too, so `sizeof<T>()` folds to exactly the constant it replaced.

### skin.ts: the last hand-written record, and why it waits

`SkinMatrixBatch#set` still writes six raw stores. They are blocked not on the
accessor tax but on a missing declaration: there is no `SkinUpdate` type, no
`offsetof` check, and `SKIN_SIZE = 32` is a bare constant. A TODO records the
record's known shape and the one unknown that gates it — whether `@4` (written
from `this.used`, a running byte offset) is an offset or a usage counter to the
host. That answer names the field, so declaring the record is a measurement
against the adapter, not a transcription of the guest.

Filed as `skin-record-undeclared`. The sixteen `physics.ts` and twenty-five
`solver.ts` stores are a different shape — RK4 state-vector slots addressed by
computed stride, not record fields — and are filed as
`state-vector-declarations`; they need a declared vector type before field
assignment is even expressible.

### Measured, for the record

Raw store and field assignment compile to the same instructions: a probe writing
four fields both ways was deduplicated by the compiler into a single function
symbol. The accessor tax the field-assignment pattern once paid is gone at
`-O3`, which is what makes this refactor free rather than a trade.

## 2026-10-23 — TensionScript 0.9.0, and the managed struct's alias fixture

### The pin moves to 0.9.0

`@yabgu_gm/tensionscript` moves from `^0.8.1` to `^0.9.0` in all sixteen
`package.json` files (`tension-framework` and the fifteen examples) and their
sixteen lockfiles. `examples/ai`'s lockfile was regenerated with
`--package-lock-only --ignore-scripts`: its `postinstall` fetches roughly 2 GB of
model weights, so the scripts never ran. The other fifteen declare no install
scripts. There is no workspace root, so every example carries its own
`node_modules`. The framework build is unchanged in shape — exit 0, the same 69
`AS235` export-class warnings — and `build/index.wasm` is 65,628 B after this
entry's fixture (0.8.1: 61,652 B).

The arena did not move: `layout_hash` is `786288195`, read from the host
(`tension-core layout-hash`) and matched against `layout.ts`. The pin is a
compiler change, not a wire change.

### What `@managed struct` is in 0.9.0

GC-owned, C layout, on the heap; the reference *is* the fields pointer (reading
A). It is `final`: no inheritance, no virtual methods. A guest copies one the
way it copies any managed object — a byte copy is not a copy, because the write
barrier matters — so `COPY_STRUCT` does not apply to managed types, and it is not
used here.

`struct` stays unmanaged permanently. The planned 0.9.0 flip to managed was
cancelled and the `TS6385` warning ("struct flips to managed") was removed, so
any 0.8.x declaration marked `@unmanaged struct` to silence that warning is now
redundant but still valid. `@managed` is a new kind, not a rename: the 35
`@unmanaged struct` declarations in this tree are byte-identical to `origin/main`
before this change.

Not supported, and not used here:

- `T[N]` fields in an `@managed` struct — the `makeZero` path has no
  `FixedArray` case (`src/compiler.ts:10688` in TensionScript). Filed.
- Inline arrays of GC references — `isManaged<Other[4]>()` returns false
  (`types.ts:885-889`), so the visitor skips element-wise tracing. Filed.
- `@abi.transfer` — not implemented in 0.8.x or 0.9.0. Filed; it needs a
  host-retention use case to design against.

### `@managed` + `@abi.alias` verified (the PR 8 gap)

This closes the deferral recorded under "the manifest gets a reader" below. PR 8
could not ship the fixture: 0.8.1 parsed `@abi.alias` on an `@managed` struct
and silently ignored it, so an assertion would have failed on the pinned
compiler while asserting nothing about the wire.

0.9.0 honors it. `ManagedAliased` (`x: u32 @abi.alias("c_x")`,
`y: u64 @abi.alias("c_y")`) is declared in
`tension-framework/assembly/runtime/managed-alias.ts` — beside `wire.ts`, not
inside it, because the struct has no host declaration or arena offset to compare
against; what it verifies is a compiler property, not a wire record.
`assertAbiAliases()` calls `assertManagedAliases()`, which checks both aliases,
the no-alias fallback on a managed struct, and `sizeof<ManagedAliased>() == 16`
(`u32` at 0, `u64` at 8).

Two-way by construction, not three-way: an alias is either recorded or it is
not, so there is no partial cell. The load-bearing check: removing `x`'s alias
compiles cleanly and aborts at runtime with

```
game aborted: ManagedAliased.x does not carry its ABI alias: c_x
```

and exit 1; restoring it returns `guest-open.ts` to `OK`. The fixture rides in
the existing `guest-open` cell, so the framework runner's count is unchanged at
23 results.

### Verified after the bump

OGRE delivery path (real adapter, NULL render system, `-O3`):
`guest-motion` `ACID 5/5 passed (structural, renderer=null)`; `guest-skinning`
`6/6`; `guest-angular` `8/8`; `guest-physics` `9/9`.

Async fixtures on the real host: `guest-push` resumed with 2; `guest-early`
resumed with 6 (buffered before the park); `guest-flow` `for+continue 9`;
`guest-chain` `got 7`; `guest-sync` `504`; `guest-drop` `-EIO`.

The three drift-check cells are guest-side and version-independent, and still
behave as recorded: `refuse` prints the corruption and `OK`; `partial` prints
`drift: SessionInfo: guest 144 != host 128` and then `OK`; `fixed` aborts with
the named diagnostic (exit 1, no `OK`).

Non-adopters: `io`, `log`, `res`, `audio`, `solver/wasm`, `solver/world` exit 0;
`bouncing-bodies` runs its 300-frame smoke and settles (`asleep 64/64`, exit 0).

### Deferred

- `T[N]` in an `@managed` struct (`makeZero`, `src/compiler.ts:10688`) — a
  compiler phase, not this one.
- Inline arrays of GC references (`types.ts:885-889`) — same.
- `@abi.transfer` — waits for a host-retention use case.
- TensionScript `alignof` for records returns the `usize` base
  (`builtins.ts:1286-1309`), the same mechanism as the pre-0.8.0 `sizeof` bug.
  Filed against TensionScript.
- `cargo test` could not be built here: `tension-core/build.rs:457` refuses the
  installed Zig (0.18.0-dev) against the pinned 0.16.x, so the suites that need
  the host were run against the prebuilt interpreter, whose source is identical
  between the two trees.

---

## 2026-10-23 — the manifest gets a reader

### Type-level drift check at session open

The host has always written a schema into the arena before the guest exists:
nine `{typeId, size, align, pad}` entries at `ArenaControl.manifestOff`
(`tension-core/src/session/arena.rs`, `TYPES`; written by `prepare_arena`).
Nothing in the guest read it. `RuntimeSession.open` now does, and compares each
entry's size against the guest's own `sizeof` for that type.

The gap it closes was measured, not supposed. `assertWireOffsets()` is 136
`offsetof<T>("field")` assertions, and every one compares the declaration
against a literal copied from the host by hand — so they prove *declaration ==
hand-copy*, never *hand-copy == host*. `SessionInfo` drifted with all of them
passing: the guest declared 128 bytes / 10 capacities / the nonce at 88 while the
host wrote 144 / 13 / 104, from `1ca1ced` (2026-10-21 02:22) until `31a6626`
(2026-10-22 02:50) — about 24 hours, not months — and the guest's check asserted
88 and 128 the whole time, because the hand-copy was stale in exactly the same
way. The new check compares against the arena the host actually wrote, so it
would have named that drift on the first open.

It runs on every guest that opens a session through the runtime — 44 call sites
across `examples/` and the test guests — rather than on the two test fixtures
that call `assertWireOffsets`. On mismatch it aborts with a diagnostic naming
the type, the guest's size and the host's
(`SessionInfo: guest 144 != host 128`), via `assert` rather than an errno: the
open *succeeded*, and a caller that ignores a return value would still proceed
on offsets it had just been told are wrong.

**What it does not catch.** Per-field offset drift: the manifest carries no
per-field offsets, so a reorder inside a record is still `assertWireOffsets`'
job, and that check has the limitation named above. Name drift: names are not
ABI — the wire carries offsets and sizes, and the host's only use of a field
name is as input to the layout hash. The two name shapes that were considered
and deferred are recorded under "Deferred" below.

**How the id → type mapping is produced.** It did not exist anywhere as data —
the correspondence lived in `tension-ogre/DESIGN.md` prose. `scripts/gen-manifest.py`
now reads `TYPES` out of `arena.rs` as text and emits
`assembly/runtime/manifest.ts`, which is committed (like `layout.ts`, which the
same build generates and `cargo test` reads). The generation is the tree's
established cross-source shape, `tension-core/tests/framework_layout.rs:34-44`:
the other side's source as text, found by shape, loud on failure — with the
direction reversed, framework reading core. It fails the build on an unparsable
`TYPES` line, a declared count that disagrees with the block, ids that are not
`1..9` ascending, an unresolvable symbolic size, or an order that disagrees with
the framework's name list. A silently empty table would make the guest's check
pass while proving nothing, so the script exits non-zero and writes nothing
instead.

**Two deliberate limits, both at the call site.**

- *Alignment is a consistency relation, not a comparison.* `entry.size %
  entry.align == 0` is checked, because a manifest that violates it is malformed
  whatever the guest declares. The entry's `align` is not compared against
  `alignof<T>()`: under the pinned TensionScript 0.8.1, `alignof` on an
  `@unmanaged struct` reports the `usize` base's alignment for every record
  (`src/builtins.ts:1286-1309` folds `type.alignLog2`, the same
  `byteSize`/`alignLog2` collapse 0.8.0 fixed for `sizeof` only), so the
  comparison would fail on every record with an 8-byte field for a reason that
  is not drift. The size comparison carries the detection on its own; a size
  change is what `SessionInfo` did. **Follow-up: TensionScript `alignof` for
  records.**
- *Type-level, against a fixed nine-entry manifest.* A host that adds a protocol
  type needs a manifest format change (a new id, and this guest's name list
  extended) — the check will fail closed on the count rather than silently
  ignore the addition, which is the intended behavior but is a coupling worth
  knowing about.

`layout_hash` is unchanged (`786288195`): the check reads the manifest, it adds
nothing to the fold.

### The guest declares `ManifestEntry`

`TYPES` id 4 pins the manifest entry itself at 8 bytes (alignment 2), and the
guest had no type for it — its own entry would have been the one id the check
could not cover. `wire.ts` now declares it as `4 × u16` (`typeId`, `size`,
`align`, `pad`), so the check covers 9 of 9 with no exception.

### Correction: the field-offset assertion count

Three numbers have been quoted for the same thing, and they measure three
different things:

- **137 canonical** — `offsetof` *code call sites* in `tension-framework` and
  `examples` (vendored trees excluded): **136 field-arg** (74 in
  `assembly/runtime/wire.ts`, 62 in `assembly/ogre/wire.ts`, every one on an
  `@unmanaged struct`) and **1 no-arg** (`examples/solver/collision/game.ts:67`).
- **141** — raw token count (`grep -o 'offsetof<'`), which counts four comment
  mentions as well. This is the number the adoption PR (#29) quotes; it is a
  filter difference, not a miscount of code.
- **128** — line count, which is short because eleven lines hold two calls each
  (`offsetof<Vec2f>("y") != 4 || offsetof<Vec2f>("y") + 4 != 8` and friends).

The canonical figure for future prose is **137**, with the filter stated.

### Deferred

- **The name shapes** — field names in the manifest, or a per-type schema hash.
  Both would need a manifest/ABI surface change and neither has a consumer
  today. Names are not ABI: the wire carries offsets and sizes. The two
  `class_` `@abi.alias` declarations stay as documentation of a reserved-word
  spelling, and the 31 camelCase↔snake_case pairs plus the OGRE decoder
  abbreviations get no aliases — aliasing a decoder-local name would record an
  implementation detail as protocol metadata.
- **`@managed` + `@abi.alias` verification.** Deferred to the 0.9.0 adoption
  phase. Under the pinned 0.8.1 the alias is honored on `@unmanaged struct` and
  silently ignored on `@managed struct` (`abiNameOf` returns the TypeScript name
  either way it is written); 0.9.0 honors both. No fixture ships until the pin
  moves, because a fixture asserting the alias would fail on the pinned
  compiler.
