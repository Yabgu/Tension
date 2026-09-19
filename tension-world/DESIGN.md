# Tension world format — design note

Status: **phase 8d complete — this document.**
Siblings: **tension-world/schema.yaml** (the vocabulary an author
writes, P8a) and **tension-solver/include/tension_solver.h** (the ABI a
world-sourced solver plugs into). This note declares the byte layout
only: the runtime form of a world — written once at compile time by the
compiler (P8c), read many times and read in place by the evaluator
(P8d). It is not the schema, not the compiler, not the evaluator.

Tension project — MIT. See LICENSE at repo root.

---

## 1 Scope

A world binary is the canonical encoded form of the data described by
`tension-world/schema.yaml`: components, connections, dimensions, and
the versions they were written against, laid out so an evaluator can
walk them and produce `f(t, y)` without parsing at runtime, without
allocating during a step, and without any string handling on the hot
path. The compiler (P8c) emits it; the evaluator (P8d) reads it; any
third-party implementation can decode it from this document alone. This
note declares the byte layout — the header, the tables, the version
fields — and deliberately declares nothing else: not the author-side
vocabulary (that is the schema), not how the compiler produces the
bytes (that is P8c), not how `f` is evaluated (that is P8d). The design
point is the resource format's: a compiled form that reads in O(1) per
access, position-independent, placed in memory once and never parsed.

## 2 The file extension and the magic

World files use the extension **`.tnw`** (Tension World), the sibling of
the resource pack's `.tns`. Like `.tns`, the extension is a **naming
convention, not a format rule**: nothing in the reader looks at the
path, and a world renamed to anything else decodes identically. This
decision affects filenames, never bytes.

The first 8 bytes of every world file are the magic constant, the exact
bytes `T N S W O R L D` in file order:

| bytes | value |
| --- | --- |
| 0–7 | `54 4E 53 57 4F 52 4C 44` — ASCII `TNSWORLD` |

An ASCII magic rather than a numeric constant, for the reason PNG and
RIFF chose theirs: it is what makes a hex dump and a `strings` pass
show the file for what it is. The version is **not** embedded in the
magic — it is a separate `format_version` u16 immediately after (§4) —
so the magic stays byte-stable across format versions and a decoder can
read version and magic independently.

## 3 Endianness, alignment, word size

Commitments, stated once and not repeated per field:

- **Little-endian everywhere.** All integers and all f64 values are
  little-endian, on every platform. A decoder on a big-endian host
  byte-swaps; nothing in the format requires it to think about it.
- **8-byte alignment everywhere.** Every section and every table entry
  begins at a multiple of 8 from file start, and every f64 sits at a
  multiple of 8. The natural boundary for the state slots drags the
  whole layout along with it; the decoder never needs an unaligned
  load.
- **Offsets are u32 byte offsets from the start of the file** — never
  from a section, never relative, never u64. A world larger than 4 GiB
  is not a world this format cares to represent (the state vector
  itself would be the first problem), and a 32-bit offset keeps the
  tables small and the arithmetic trivial. `0` as an offset value
  means "absent" (no section or no name begins at byte 0 — that is the
  magic).

The type vocabulary used below: `u8`, `u16`, `u32`, `u64` (unsigned
integers, LE), `f64` (IEEE-754 binary64, LE), and `bytes` (raw, no
terminator, no encoding implied except where stated). `u64` is declared
for completeness; format_version 1 does not use it.

## 4 Top-level layout

The file is, in order: the header, the component table, the connection
table, the name table. The tables follow immediately, each starting on
an 8-byte boundary; the name table is last and runs to the end of the
file. All layout is position-independent: every offset is from file
start, so the same bytes decode wherever they are placed in memory.

**Header — 40 bytes at file offset 0**

| off | size | field | notes |
| --- | --- | --- | --- |
| 0 | 8 | `magic` | ASCII `TNSWORLD` (§2) |
| 8 | 2 | `format_version` u16 | 1 for this document |
| 10 | 2 | `schema_version` u16 | the `tension-world/schema.yaml` version the source YAML targeted |
| 12 | 1 | `dimensions` u8 | 2 or 3 |
| 13 | 1 | `flags` u8 | reserved; must be 0 in format_version 1 |
| 14 | 2 | `reserved` u16 | must be 0; pads the u32 block to offset 16 |
| 16 | 4 | `component_count` u32 | entries in the component table |
| 20 | 4 | `connection_count` u32 | entries in the connection table |
| 24 | 4 | `component_table_offset` u32 | from file start; 40 in every format_version 1 file |
| 28 | 4 | `connection_table_offset` u32 | from file start |
| 32 | 4 | `name_table_offset` u32 | from file start; 0 when the name table is empty |
| 36 | 4 | `reserved2` u32 | must be 0; pads the header to 40 |

The two offset fields that would otherwise be derivable (`component_
table_offset` is always 40, and the connection table always follows the
component table) are stored anyway: this is the one section a decoder
reads first, and it must be unambiguous without walking anything. A
decoder refuses a file whose offsets disagree with the tables' actual
extents.

**Refusal rules.** A decoder refuses, with a clear error naming the
field: a wrong magic; a `format_version` it does not know; nonzero
`flags`, `reserved`, or `reserved2`; `dimensions` outside {2, 3}; any
table offset that is not 8-byte aligned or that overlaps another
section; and counts that cannot fit inside their tables. Refusal is at
load time — the file is never half-read.

## 5 Component table

`component_count` entries, back to back, in declaration order. Entry
order **is** state-slot order: the evaluator derives each component's
slots by accumulating contributions in this order (schema §dimensions),
so the binary stores no slot indices — storing derived data invites
disagreement, and the walk is over tens of entries, not thousands.

Entries are variable-length because the file can mix component types;
the decoder walks by reading the type tag, looking up that type's entry
size for the file's `dimensions`, and advancing. An unknown type tag
refuses the file.

**Entry header — 8 bytes, every component type**

| off | size | field | notes |
| --- | --- | --- | --- |
| 0 | 2 | `type_tag` u16 | 1 = `point_mass`, 2 = `kinematic`, 3 = `anchor`; 0 is reserved (never a valid tag) |
| 2 | 2 | `reserved` u16 | must be 0 |
| 4 | 4 | `name_offset` u32 | into the name table (§7); never 0 — component names are required |

**`point_mass` fields — after the 8-byte entry header**

| off | size | field | notes |
| --- | --- | --- | --- |
| 8 | 8 | `mass` f64 | > 0 |
| 16 | 8·d | `position` d × f64 | the component's first `d` state slots |
| 16 + 8·d | 8·d | `velocity` d × f64 | the component's next `d` state slots |

**`kinematic` fields — after the 8-byte entry header**

| off | size | field | notes |
| --- | --- | --- | --- |
| 8 | 8·d | `position` d × f64 | state slots, same layout as `point_mass` |
| 8 + 8·d | 8·d | `velocity` d × f64 | state slots |

**`anchor` fields — after the 8-byte entry header**

| off | size | field | notes |
| --- | --- | --- | --- |
| 8 | 8·d | `position` d × f64 | no state slots; position is read-only data |

Entry sizes, with `d = dimensions`:

| type | d = 2 | d = 3 | arithmetic |
| --- | --- | --- | --- |
| `point_mass` | 48 | 64 | 16 + 16·d |
| `kinematic` | 40 | 56 | 8 + 16·d |
| `anchor` | 24 | 32 | 8 + 8·d |

Every size is a multiple of 8, so the inline layout above keeps §3's
alignment promise without padding anywhere. The layout is **(a) inline
— each entry carries its own values** (the phase brief's lean, and the
right one): it is smaller, it needs no second indirection, and the
declaration-order walk that produces state slots falls out of the
entries' order naturally. A table-of-offsets layout is what you pick
when you intend to append to a file later; nothing in this design
appends.

## 6 Connection table

`connection_count` entries, back to back, in declaration order (the
connection list has no state-slot meaning; order is just stable
iteration). Variable-length the same way, walked the same way.

**Entry header — 16 bytes, every connection type**

| off | size | field | notes |
| --- | --- | --- | --- |
| 0 | 2 | `type_tag` u16 | 1 = `spring`, 2 = `pin`, 3 = `gravity`; 0 reserved |
| 2 | 2 | `reserved` u16 | must be 0 |
| 4 | 4 | `name_offset` u32 | into the name table; 0 = unnamed (connection names are optional) |
| 8 | 4 | `from` u32 | component-table index; `0xFFFFFFFF` for `gravity` |
| 12 | 4 | `to` u32 | component-table index; `0xFFFFFFFF` for `gravity`; must differ from `from` for binary connections |

**`spring` fields — after the 16-byte entry header**

| off | size | field | notes |
| --- | --- | --- | --- |
| 16 | 8 | `stiffness` f64 | > 0 |
| 24 | 8 | `rest_length` f64 | ≥ 0 |
| 32 | 8 | `damping` f64 | ≥ 0 |

**`pin` fields — after the 16-byte entry header**

| off | size | field | notes |
| --- | --- | --- | --- |
| 16 | 8·d | `offset` d × f64 | the constrained from→to displacement |

**`gravity` fields — after the 16-byte entry header**

| off | size | field | notes |
| --- | --- | --- | --- |
| 16 | 8·d | `acceleration` d × f64 | world-directed; `from` = `to` = `0xFFFFFFFF` |

Entry sizes, with `d = dimensions`:

| type | d = 2 | d = 3 | arithmetic |
| --- | --- | --- | --- |
| `spring` | 40 | 40 | 40 (fields are scalar) |
| `pin` | 32 | 40 | 16 + 8·d |
| `gravity` | 32 | 40 | 16 + 8·d |

**How the evaluator uses this.** On each `f(t, y)` evaluation it walks
the connection table once, in order: for a binary connection it
resolves both endpoints' current positions (and velocities for
`damping`) from `y`, using the slot bases it derived from the component
table in §5's order; for `gravity` it contributes its acceleration to
every `point_mass`. Nothing in a connection entry is mutable state: no
force is cached, no accumulator is stored — `f(t, y)` is a pure
function of the binary and the current `y`, which is what the solver's
determinism contract (§5 of the solver's design note) rests on.

## 7 Names and diagnostics

Component and connection names **are** in the binary; they exist for
diagnostics and host introspection, never for evaluation: the evaluator
resolves everything by table index and does not touch the name table
during a step.

**Name table** — a byte region at `name_table_offset`, running to the
end of the file. It is a concatenation of length-prefixed UTF-8 names:

| off | size | field | notes |
| --- | --- | --- | --- |
| +0 | 4 | `byte_length` u32 | UTF-8 bytes that follow |
| +4 | 8·n/8 | `bytes` | exactly `byte_length` UTF-8 bytes — no terminator, no padding |

Offsets in the tables point at a name's `byte_length` field; `0` as a
`name_offset` means the entry is unnamed (valid for connections,
never for components — the schema requires component names). Names are
unique in a well-formed file, but the binary layout does not re-check
that: uniqueness is the compiler's contract, and a malformed world
caught at compile time never becomes bytes.

The cost of including names is a few hundred bytes per world; the payoff
is a runtime that can say *which* component held a NaN position instead
of "index 3". The evaluator never pays it on the hot path.

## 8 Templates — zero footprint

Templates are a compile-time expansion (schema §templates) and leave no
trace in the binary: there are no template nodes, no template table, no
flag marking which components came from an expansion. Every component
and connection entry above arrived from either a plain declaration or
an expansion, and the format does not distinguish them — a compiled
world is exactly the set of things that exist.

## 9 Versioning

Two version fields with two different jobs, deliberately not moving
together:

- **`format_version`** is the byte layout's version. It is bumped only
  when the layout changes incompatibly — a field reordered, a type
  widened, a section moved. It is a breaking-change signal: a decoder
  that sees a `format_version` it does not know refuses the file with a
  clear error rather than guessing. Format_version 1 is the layout in
  this document, and the only version that exists.
- **`schema_version`** is the `tension-world/schema.yaml` version the
  source YAML was written against. It tells the compiler which
  vocabulary was meant — features that changed between schema versions
  can be diagnosed with the right message. It is authoring-context
  information; a decoder never branches on it.

A layout change without a schema change bumps `format_version` alone; a
vocabulary addition that compiles to the same layout (a reserved type
landing, say) bumps `schema_version` alone. The two fields are the
`.tns` profile decision applied again: the format carries both the
breaking-change signal and the authoring-context signal, and neither is
inferred from the other.

## 10 What this document is not

- **Not the schema.** The vocabulary an author writes is
  `tension-world/schema.yaml` (P8a); this document only says what that
  vocabulary compiles to.
- **Not the compiler.** How YAML becomes these bytes — the parser
  subset, template expansion, validation order, error messages — is
  P8c.
- **Not the evaluator.** The evaluator's contract — force arithmetic,
  constraint handling, `kinematic` treatment — is §12; the layout
  sections above declare the bytes it reads.
- **Not the memory placement.** The host loads the bytes; wasm reads
  them from the same linear memory. The layout is position-independent
  (every offset is from file start), so placement is the loader's
  business and nothing here changes with it.
- **Not a serialization of a Rust struct or a Fortran derived type.**
  It is a byte layout, defined without reference to any implementation
  language, and any language can read it.

## 11 Known limitations (recorded, not hidden)

- **No compression.** A world binary is small (tens of components,
  kilobytes), and decompressing at load would add a runtime step for a
  size win nothing here needs. If worlds ever grow cartographic, this
  is the first entry to revisit, with a `format_version` bump.
- **No partial loading.** The whole binary is placed in memory and read
  in place; the format has no chunking, no streaming, and no notion of
  a world too large to hold at once.
- **`format_version` 1 is the only version.** Future versions exist on
  paper, not in a reader: there is no compatibility shim, no migration
  path, and no promise that version 2 will decode version 1 files
  except by a deliberate decision recorded here.
- **No integrity checksum.** A truncated or corrupted file is caught by
  the structural refusal rules (§4) and by bounds-checked table walks,
  not by a hash; the format does not detect a plausible-looking
  corruption that happens to satisfy every structural rule.

---

## 12 The evaluator (phase 8d)

Phase 8d reads these bytes: `tension-core/src/world/eval.rs`, a Rust library
next to the compiler. `World::load(&bytes)` validates the file — every §4
refusal, with one addition named below — and returns a borrowed view that
owns nothing and allocates nothing; `World::dim()` is the state vector's
length; `World::dimensions()` is 2 or 3; `World::eval(t, y, out)` writes
`f(t, y)`. The bytes stay owned by the caller, and every later read is an
offset into them.

**What f is, per component** — the §5 walk made arithmetic. For a
`point_mass`: its position slots in f are its velocity slots in y (a
position's derivative is the velocity), and its velocity slots are the
total force on it divided by its mass. For a `kinematic`: position slots
are velocity, velocity slots are zero — nothing in v1 drives a kinematic
body, which is what makes it the engine's "do not integrate this" type.
For an `anchor`: nothing, in either vector. `dim` is the sum of the
components' slot counts in declaration order, so f's layout is y's
layout, and anchors shift component indices without shifting slots.

**The force convention.** Springs carry the whole force vocabulary in v1.
For a spring's entry, `dir` is the unit vector from the `from` component's
current position to the `to` component's — orientation is part of the
entry, and the force flips sign with the end being evaluated — and the
scalar magnitude is `-k·(dist − rest_length) − c·(v_rel · dir)`, with
`v_rel` the to-side velocity minus the from-side. The force on the `to`
end is `magnitude · dir`; on the `from` end, its negation. So a stretched
spring pulls its ends together, a compressed one pushes them apart, and
damping opposes radial motion — and damping acts even at zero
displacement, because it is a term of its own. A spring whose endpoints
coincide has no axis to pull along; v1 contributes no force rather than a
NaN direction. Gravity is an **acceleration**, not a force: it adds
`mass · a` to every `point_mass` — equivalent to adding `a` to the body's
acceleration, but the force form is what the accumulator holds — and it
touches neither kinematic bodies nor anchors. An anchor's position comes
from its entry, not from y (anchors have no state slots, §5), and its
velocity is zero by construction. `t` is accepted as the solver's calling
convention and currently unread: no v1 connection makes f depend on time.

**The pin decision.** `pin` is a rigid constraint, and the evaluator
refuses a world that carries one: `f(t, y)` receives neither a solver nor
`dt`, and a rigid constraint needs an iterative position solve or a
Lagrange-multiplier formulation that depends on the step. Refusing is
deliberate and visible — the error names the connection and says v1 does
not implement it — and it follows the solver's spook precedent: the
vocabulary is declared, the implementation is deferred, and nothing
pretends. The compiler still accepts `pin` (P8c), so a future phase that
gives evaluation a `dt`-aware channel revives it without touching the
compiler or these bytes.

**One refusal beyond §4's list.** `load` refuses a connection whose
endpoints do not name component-table entries (`from`/`to` in range,
gravity's sentinel endpoints on both ends, a binary connection's ends
distinct) — §4's "refusal is at load time; the file is never half-read"
applied to references. Without it, a dangling endpoint would evaluate as
if its connection were absent, which is the kind of silent wrong answer
§4 exists to prevent. Everything else semantic stays the compiler's:
a spring's stiffness, a mass — the loader does not re-litigate them, and
evaluation assumes them (a hand-built binary that breaks one gets IEEE
arithmetic, not an error).

**No allocation, because determinism.** `eval` allocates nothing: the
per-component force accumulator is a `[f64; 3]` on the stack, and the
component gather walks the connection table in place — component count
times connection count, tens of entries, no index built. A test proves it
with a counting allocator (T13 in
`tests/world_p8d.rs`). Purity is the other half: no globals, no interior
mutability, no time — same `(t, y)`, bit-identical `out` — which is what
the solver's determinism contract (§5 of the solver's note) composes
with.

**What phase 8d does not deliver.** No integration: the evaluator computes
a derivative, the solver takes steps; that split is the coprocessor's
whole point. No constraint solver: `joint_angle`, `contact`, and `pin`
await a `dt`-aware evaluation channel. No `source: "world"` wiring: the
shim still answers `-ENOSYS`, and accepting a world's derivative on the C
side is P8e. And no scene loading: `World::load` reads bytes the caller
already has (P8c's compiler produced them; P8e will decide where a game's
bytes live).
