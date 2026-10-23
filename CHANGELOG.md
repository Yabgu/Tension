# Changelog — the Tension tree

Repo-level. One file for the whole tree (`tension-framework`, `tension-core`,
`tension-ogre`, and the capability crates beside them): the guest SDK, the
interpreter and the adapters are released together, because an adapter is built
against the arena's shape hash and a guest is compiled against it, so a version
line per directory would only ever move in lockstep. Per-crate extraction is
deferred until the tree splits release cycles, and that split would be the reason
to do it, not a reason to do it now.

Entries are dated rather than numbered: Tension does not version independently
of TensionScript today (the guests' compiler is `@acakar/tensionscript`, pinned
in `tension-framework/package.json`), so there is no Tension version number to
attach a change to.

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
