# tension-ogre — design note

Status: **round 5 — the chunk-1 contract is frozen; no code written yet.**
Siblings: **tension-core/include/tension_adapter.h** (the core ↔ adapter C ABI;
specified in Appendix A, not yet committed), **tension-ogre/include/tension_ogre.h**
(the capability's own guest-facing C ABI; chunk 2), and
**tension-framework/assembly/{session,ogre}/** (the guest SDK; chunk 1, phase A3).

Tension project — MIT. See LICENSE at repo root.

---

## 0. Decisions

The calls this document makes, in the order a reader will want them. Everything
else in the note is elaboration.

- **Errno for a missing memory import: `-EINVAL`.** A guest that imports
  `session::*` but declares no memory import is refused, and so is a session
  guest in the verb-level defence. `-EPROTO` was considered and deliberately
  **not** introduced: the information lives in the named diagnostic on the
  `[tension:session]` channel, and the repo's discipline is one small declared
  errno table per capability rather than a new code per failure.
- **Re-entrancy: `-EBUSY` for `session_wait` and `session_drain` called from
  inside a callback; `queue_*` verbs defer instead.** A deferred submission is
  *copied* at the moment of the call and applied after the batch, so a callback
  that submits work is legal and cannot lose data.
- **`FAULTED → READY` is refused with `-EBUSY`.** The guest must call
  `session_close` first. A session that faulted has half-published state;
  forcing a close makes reopening an explicit act rather than a silent reset.
- **Events are advisory, status tables are truth.** A dropped event is
  reconciled from the `JOB` / `RESOURCE` tables. That is what makes batching
  safe, and it is why event rings have soft capacity (drop and count) while
  status tables have hard capacity (refuse with `-ENOSPC`).
- **Region kinds are frozen at twelve for chunk 1; `kind == index`; region
  sizes are compile-time constants.** `arena_size` selects how much of the
  fixed layout is *live*; `ring_capacity_<class>` resizes sub-rings *inside*
  the fixed `EVENT_TABLE`. Nothing at `session_open` moves a region's offset.
- **Canaries are detection, not prevention.** They make the common
  `memoryBase` drift loud and fast; they do not make overlap impossible, and
  the hard guarantee is the build pipeline that derives the flags and the
  constants from one file.
- **The memory is session-provided (Model A).** Address 0 is the arena, the
  guest's heap begins at `memoryBase`, and there is no pointer handshake.
- **Verified by probe (both green, §13):** one `Memory` can be defined under
  two import names with shared state, and a module's declared memory import
  type is readable before instantiation. The two questions that gated the
  contract are answered; nothing in the wire format had to change.

---

## 1. The design in one paragraph

> **tension-ogre** exposes the OGRE-Next rendering engine to a Tension guest as
> the wasm import module `ogre`, through a capability adapter loaded by
> `tension-core`. Tension is a broker and not an abstraction layer: the adapter
> carries OGRE's own contract faithfully, the core carries none of it, and this
> document describes the boundary between them rather than a rendering API of
> Tension's invention. Delivery is not the capability's business. Every
> capability adapter — OGRE today, others later — posts events, tagged by class,
> to the **session**: a core-owned coprocessor that owns the shared arena, the
> per-class host-side queues, the subscriptions and delivery modes, the
> scheduler that decides when delivery happens, and deferred submission. The
> arena is a staging area with a rendezvous at each host call: the guest writes
> into it, calls a session or capability verb, and the session reads and
> publishes inside that call on the guest thread. Adapter background and render
> threads never call the guest and never touch guest linear memory; they post,
> and the session delivers — batched by class where volume demands it, one
> callback per event where urgency does. The arena itself is session-provided:
> the session creates and owns the memory before instantiation, the guest
> imports it, address 0 is the arena, and the guest's heap begins at `memoryBase`
> above the reserved band — no pointer handshake, no guest-supplied layout.
> Status tables are the truth and events are advisory: a dropped event is
> reconciled from the table, which is what makes a million loads a scheduling
> problem rather than a delivery problem, and is also why the in-flight window
> is bounded by table capacity and must be sized deliberately. Chunk 1 delivers
> the contracts and the loader — the wire catalogue, the session, the adapter
> ABI, and the OGRE header — and contains no OGRE code at all; the version pin
> is a build-time concern that the wire format does not depend on.

## 2. Scope and the broker rule

`tension-ogre` is the first capability that is not a built-in service.
`tension::io`, `tension::audio`, `tension::ai`, `tension::res` and
`tension::solver` are Tension's own; the `tension::` prefix is reserved for
them. A capability's wasm module name is its own — `ogre` — and its C symbols
are prefixed `tension_ogre_`; the module name and the symbol prefix are
different namespaces and may coincide.

Three rules follow from the broker decision and constrain everything below:

1. **The core knows nothing about OGRE.** Every OGRE-shaped fact lives in the
   adapter. The core knows how to load a shared object, validate signatures,
   hand out guest memory, resolve callbacks, post and deliver events, and
   nothing else.
2. **No cross-capability assumptions.** An adapter may not assume another
   adapter is loaded, may not read another capability's records, and may not
   register an import another adapter already claimed (the second registration
   is refused deterministically, not first-wins).
3. **No magic names in the guest.** `_start_game` is the only guest export the
   host looks up by name; every host → guest call is through a function-table
   index the guest registers in the `Callbacks` record.

The wasm module `session` is core-owned and reserved: an adapter that registers
an import there is refused at load.

## 3. The session

### 3.1 Ownership

The session is a first-class component owned by `tension-core`, not a
per-capability helper. It owns:

- the shared memory and the arena's protocol-level layout (control block,
  region table, manifest, canary lattice);
- one host-side MPSC queue per event class;
- subscriptions (per-class delivery mode), with class defaults;
- the scheduler that decides when delivery happens — the **epoch**;
- deferred submission: the pending list, and the copied records it holds.

### 3.2 Event classes and delivery modes

Ten classes in chunk 1. The id is both the subscription key and the delivery
priority: an urgent class needs a low id, because invocation follows class id
order within an epoch.

| id | class | default mode | ring capacity (default) |
| --- | --- | --- | --- |
| 0 | `DEVICE_LOST` | DIRECT | 1 |
| 1 | `JOB_FAILED` | DIRECT | 256 |
| 2 | `RESOURCE_FAILED` | DIRECT | 256 |
| 3 | `SUBMISSION_REJECTED` | DIRECT, always delivered | 64 |
| 4 | `JOB_DONE` | BATCHED | 4096 |
| 5 | `RESOURCE_READY` | BATCHED | 4096 |
| 6 | `INPUT_KEY` | BATCHED | 256 |
| 7 | `INPUT_MOUSE` | BATCHED | 64 |
| 8 | `LOG` | BATCHED | 1024 |
| 9 | `FRAME` | POLLED | 256 |

**The code is normative, this table is descriptive.** The authoritative class
list is `tension-core/src/session/arena.rs`'s `CLASSES` (ids and names) with
`DEFAULT_CLASS_MODES` beside it; the table above is how the design explains the
order. Where they disagree, the code wins — and one place they did:
`SUBMISSION_REJECTED` is **class 3**, not the last class. Round 3 introduced it
last; the urgent-first ordering the same round adopted places it third, and
every consumer (the frozen capacities, the modes, the AS runtime's constants)
follows the code. Read §3.3's prose about classes as *categories* — "the
failures", "the completions" — rather than as a second statement of ids.

Two notes on this table. `SUBMISSION_REJECTED` is an addition to the class list
as it stood at round 3: a deferred submission has a second failure mode — it is
*accepted* inside a callback and can *fail* when applied later, when the guest
is not inside a call that could receive an errno — and without this class that
failure would be invisible. It is always delivered, not opt-in. And the list is
ordered urgent-first, which renumbers `JOB_DONE` and the classes after it
relative to the round-3 listing; the rule "class id doubles as delivery
priority" was stated in round 3 and this is the ordering it implies.

Four delivery modes: `DIRECT` (1) one callback per event, for rare and urgent
classes; `BATCHED` (2) accumulate, one callback per class per epoch, records
landing contiguously in the class's sub-ring; `RING` (3) the adapter's records
land in the guest ring with no callback, the guest reads at its own pace —
**reserved and stubbed in chunk 1**; `POLLED` (4) no automatic delivery, the
guest calls `session_drain`. `DIRECT` and `BATCHED` are required in chunk 1.

### 3.3 Delivery: the epoch

`session_wait(timeout_ms)` blocks until any class queue is non-empty, a fault
or shutdown is signalled, or the timeout expires; `session_drain(class)` is the
same epoch restricted to one class and never blocks. An epoch is three phases:

1. **Publish.** Freeze the delivery set. The session writes the control-block
   fault fields and `FrameState`, then appends to each non-empty class's
   sub-ring (compacting on wrap, counting drops), then calls each loaded
   adapter's `publish` hook once, in registration order, so it can write its
   own host → guest regions. Guest memory is acquired per call and never held
   across a callback.
2. **Invoke.** For class in ascending id, for each class with deliveries:
   `BATCHED` ⇒ one `onBatch(class, table_ptr, count)`; `DIRECT` ⇒ one
   `onEvent(class, ptr)` per record, ascending `seq`. Publishing for the whole
   epoch completes before the first invocation, which is what keeps an exempt
   accessor called from inside a callback consistent.
3. **Apply.** Deferred submissions are applied through each adapter's `apply`,
   with depth reset to 0. A failure becomes a `SUBMISSION_REJECTED` delivery in
   the next epoch.

Ordering guarantees: within a class, `seq` ascending; across classes, class id
ascending, and cross-class temporal order is available only by comparing `seq`,
which the session assigns globally at post time.

Two contracts make batch pointers free. The `(ptr, count)` a callback receives
is valid **for the duration of that call only** — a guest that wants to keep
records copies them. And the guest's `tail` is **space reclaim, not an
acknowledgement**: the session keeps its own host-side delivery watermark, so a
guest that never advances the tail cannot cause duplicate callbacks or an
unbounded loop — it simply fills its ring, and then records are dropped and
counted.

**A capability whose work completes only in `publish` cannot be relied upon with
an unbounded `session_wait`.** (No loader thread, no render thread: the work
happens because a publish phase runs, and a publish phase runs because a verb
asked for an epoch.) A guest that blocks in `wait(-1)` *before* any event
exists is therefore waiting for work that only the blocked verb could have
advanced — a cycle, and the wait holds it. Such a capability is driven by
polling (`wait(0)`, `drain`) or by giving the capability asynchronous
completion of its own. A loader thread or a render thread lifts the
limitation entirely: that work finishes off-thread, `post_event`s, and the
post wakes a blocked wait exactly as the first sentence of this section
promises. The measured case is the OGRE stub adapter, whose publish hook is
what completes a job — `tension-framework/tests/guest-ogre.ts` polls `wait(0)`
for that reason, with the reasoning in the fixture.

### 3.4 The EventTable: per-class sub-rings

One `EVENT_TABLE` region holding, for each class in ascending id, a 32-byte
table header followed by `capacity × 32` bytes of `EventRecord`s; each sub-ring
16-byte aligned. Two alternatives were considered and rejected:

- **A single shared ring with class tags.** Simpler, and it fails on the
  signature: `onBatch(class, table_ptr, count)` promises a contiguous run of
  one class's records, and classes interleave as events arrive, so a shared
  ring cannot produce that run without a per-class compaction copy — the same
  memory as sub-rings, plus a copy, plus a second place for the layout to be
  wrong.
- **A guest-visible single tail.** Correct only if delivery is exactly-once per
  tail advance; the session's own watermark (above) is what keeps a slow guest
  from turning the ring into a callback loop.

Per-class sub-rings give per-class backpressure, per-class overflow counters,
storage matching the modes, and make `session_drain(class)` natural.

**Where the counters live.** The authoritative `dropped` and `delivered`
counters are host-side, on each class's `ClassQueue` in the posting face
(`dropped()`, `delivered()`, `note_flushed()`): that is where a drop actually
happens — a full queue refuses a post, a full ring refuses an append — and it is
the only copy the session's own bookkeeping reads. Each epoch's publish phase
**mirrors** the current values into the class's `TableHeader` fields at offsets
20 (`dropped`) and 24 (`delivered`), so the guest can see a per-class count
without asking; `FrameState.droppedEvents` is the cross-class rollup. The arena
copy is a *report*: a guest that writes it changes nothing the session believes,
and the next publish overwrites it with the host's number.

### 3.5 Deferred submission

A `queue_*` verb called from inside a batch or event callback is legal: the
session **copies** the record at that moment and appends it to the pending list,
and the guest sees the submission take effect as of the next wait. Copying is
the load-bearing detail — a deferred `(verb, guest_ptr)` pair would be re-read
after arbitrary guest code had run — and it is also what makes the list safe
across a trap (R7): the pending list survives a callback trap, is applied at
the next wait, and each apply that fails becomes a `SUBMISSION_REJECTED`
delivery. The list is bounded per callback; a `queue_*` that would exceed the
bound returns `-ENOSPC` to the guest synchronously, inside the callback.

`session_wait` and `session_drain` from inside a callback are refused with
`-EBUSY`, as is any other verb that would re-enter the pump. Exempt accessors
(the capability's read-only state verbs) run normally: they neither pump nor
block.

## 4. Model A — the memory model

The session creates the `Memory` at store setup, **before**
`linker.instantiate`, and the guest imports it. Sizes are not host-chosen
numbers: the host mirrors the module's declared import type and caps it.

- `initial_pages = declared_min_pages` (provide at least; never less)
- `max_pages = min(declared_max_pages, host_cap_pages)`, or `host_cap_pages`
  when the module declares no maximum.
- `guest_initial_heap_slack` and `guest_max_heap` are **build-side** concepts —
  they are already inside what `asc` declares — not host-side inputs.

### 4.1 The four numbers and the consistency relation

The design speaks of four numbers: `arena_size` (the live arena),
`max_arena_size` (the reserved ceiling, and the guest's `--memoryBase`),
`--memoryBase` (where the guest's emitted segments begin), and
`--maximumMemory` (the guest's declared maximum). One identity and one
relation tie them: `memoryBase == max_arena_size` and
`arena_size ≤ max_arena_size`. Everything else is derived — page counts come
from the module (§4 above), not from a tuning exercise.

Four constraints are checked at `session_open`, in this order:

- **C1** `arena_size ≤ max_arena_size`, both nonzero, both 16-byte aligned,
  `arena_size ≥` the layout floor.
- **C2** `max_arena_size ≤ declared_min_pages × 64 KiB − guest_footprint_floor`.
  The witness is the *module's* declared minimum, which encodes the build's
  `memoryBase` — not anything the guest says at runtime. This is the drift
  detector, and it is why there is **no `memory_base` key in the TLV**: the
  wasm binary is a better witness than a runtime claim.
- **C3** import match: `declared.min ≤ provided.min` and
  `provided.max ≤ declared.max`. Probe-confirmed in both directions (§13): a
  provided memory with a smaller minimum, a larger maximum, or no maximum at
  all is refused at instantiation. wasmtime's own message is generic
  (``incompatible import type for `env::memory` ``), which is why the session
  pre-checks and names the offending page counts itself.
- **C4** layout fit: header page plus the aligned region sizes ≤ `arena_size`;
  each region at its declared alignment; ring capacities ≥ 1 and each class's
  sub-ring inside its slice of `EVENT_TABLE`; the `STRING` region ≥ 32 B plus
  two usable halves.

### 4.2 F1 — the import module name

AssemblyScript 0.28.8 hardcodes the memory import module to `env`: the pinned
toolchain's own option table describes `--importMemory` as *"Imports the memory
from 'env.memory'."*, and the compiler emits
`addMemoryImport(DefaultMemory, DefaultNamespace, Memory, …)` with
`DefaultNamespace = "env"`. So `(import "session" "memory")` is not expressible
in AssemblyScript without rewriting the emitted module.

The session therefore defines **one** `Memory` under both `("env","memory")`
(for AssemblyScript guests, unmodified) and `("session","memory")` (for
hand-written WAT guests, non-AssemblyScript guests, and Tension's documented ABI
name). A build-time rewrite of the import module name was rejected: the repo has
the machinery (`src/dwarf/wasm.rs`, `src/leb.rs`) but it buys nothing semantic.
The residue is documented rather than hidden — for an AssemblyScript guest the
`session` spelling is aspirational, `env` is what actually appears in the
binary, and both names resolve to the same object.

### 4.3 F2 — `--noExportMemory` is forbidden

`--importMemory` alone still *exports* memory as `"memory"`; only
`--noExportMemory` suppresses it (`setExportMemory(T, !r.noExportMemory)`), and
a module may re-export an imported memory. Because the existing services reach
guest memory through `caller.get_export("memory")` — `main.rs`'s
`guest_path`/`write_guest`/`read_as_string`/`print`/`read_line`/`arg`,
`audio::read_pcm`, `ai`'s helpers, `solver::resolve_callbacks` — suppressing
the export would break all of them, and the failure would surface as a panic
inside `print`'s `expect("game must export a memory named 'memory'")`.

Two measures: the build pipeline forbids `--noExportMemory`, and the session
refuses at load a module that imports a memory but does not export one named
`memory` (§11).

## 5. The arena

### 5.1 Header page and fixed offsets

```
0x000  ArenaControl          256 B   session-written
0x100  SessionInfo           128 B   session-written
0x180  reserved              128 B   zeroed
0x200  RegionDesc[12]        288 B   session-written, kind == index
0x320  manifest               72 B   session-written, read-only to the guest
...    zero padding
0x1000 regions, in kind order
```

**What `layoutHash` covers.** Not just each record's size and alignment: the
**byte offset of every field a guest reads directly** is folded in too, by
(field name, offset) pairs. A field *reorder* inside a record is now a hash
change, which is the point — a guest compiled against one order would otherwise
read another order's bytes and call it data. The records covered are
`EventRecord`, `TableHeader`, `RegionDesc`, `ArenaControl`, `SessionInfo`,
`Callbacks`, `StringHalf`, `Subscription` and `FrameState`. (The round that
introduced this listed eight of those; `FrameState` joins them under the same
principle, and its field offsets are defined in `arena.rs` with the rest.)

**The shape did not move; the fingerprint widened.** No offset in the arena
changed, so `FORMAT_VERSION` and `SCHEMA_VERSION` stay 1 — the sentence above
about `schemaVersion` is about adding a *manifest entry*, which does move the
bytes after it. The hash value did change, so a guest built before this round is
refused at `session_open` with the field and both values named. That refusal is
the intended effect, not a regression: there is no such guest yet — the SDK is
A3 — and folding the fields in now is what makes the first compiled guest's hash
mean what it says.

The first 4 KiB is the header page. With twelve regions and nine manifest
entries the header occupies about 900 bytes, leaving room for both tables to
grow without moving a region. Each region starts at its declared alignment and
its size is padded to 16 bytes.

**The manifest holds the protocol types whose sizes this design fixes** —
currently nine entries: `ArenaControl`, `SessionInfo`, `RegionDesc`, the
manifest entry itself, the ring header (`TableHeader`), `StringHalf`,
`Callbacks`, `Subscription` and `EventRecord`. The capability records — the
OGRE catalogue's math types, staging records and job records — are **deferred
until the version pin**, because their field sets are the thing this note
deliberately leaves to the adapter; the manifest is extended then. Since the
layout hash covers the catalogue, adding an entry is a schema change: it moves
the hash, bumps `schemaVersion`, and requires the guest SDK to be regenerated
from the same table.

**The pin (chunk 2).** OGRE-Next **v3.0.0**, commit
`75643c3997f5b6d2aa1d7bd8400b9be6736d9908`
(<https://github.com/OGRECave/ogre-next>). Verified against the Arch package
`ogre-next 3.0.0-2`; the build checks the version with
`pkg-config --atleast-version=3.0.0 OGRE-Next`, and the SHA is documentation
and the source-build recipe's checkout ref — the wire format never reads it.
The condition this section named is therefore satisfied: the submission
sub-chunk may write the capability catalogue that
`assembly/ogre/wire.ts` already implements.

**Attaching an `Item` is `SceneNode::attachObject`.** OGRE-Next 3.0 has no
`Item::attachToNode` and no constructor path into a node: the object is
`sceneManager->createItem(meshPtr, SCENE_DYNAMIC)`, given a datablock with
`Item::setDatablock`, and attached with `node->attachObject(item)`. Measured,
after a guess in the other direction cost a probe.

**A capability record's fields are scalars, because a class field is a
pointer.** The wire catalogue's rule, stated here as the general one it is: in
an `@unmanaged` record, a field whose type is a class holds a *reference* — four
bytes pointing at the object — not an inline struct, so `position: Vec3f` is not
twelve bytes of position and a record written that way does not mean what it
says. Nested structures are therefore expressed as flat scalar fields at
explicit offsets, with the padding spelled out. The placement rule that goes
with it: a 16-byte type (`Vec4f`, `Quatf`, `Colourf`, `Mat4f`) must sit at a
16-byte offset, or the record carries explicit pad fields to put it there —
which is why `MotionUpdate` has flat `positionX/Y/Z`, `rotationX/Y/Z/W`,
`scaleX/Y/Z` with a `pad0 u64` in front rather than `Transformf`-shaped fields.
The offsets are pinned by `checkOgreWireOffsets` and by `checkOgreMotionOffsets`,
which a guest can assert on its own.

**`createItem` needs both Hlms registered, not just the one its datablock
comes from.** Measured while writing the motion probe: `Barrel.mesh`'s
sub-items name the material `RustyBarrel`, OGRE routes an unknown material name
to the PBS Hlms, and with only `HlmsUnlit` registered `createItem` **segfaults**
inside `Hlms::getDefaultDatablock` — it does not refuse. The adapter registers
both for that reason; anything that builds an OGRE scene from these meshes must
too.

**The Hlms is built from archives, and links separately.** `HlmsUnlit` and
`HlmsPbs` take an `Archive*` (their language folder, `Media/Hlms/<Hlms>/GLSL`)
and an `ArchiveVec*` of library folders, with the sources first and the library
last: `Common/GLSL`, `Common/Any`, **and the Hlms's own `Any` folder**. Both
`Any` folders are required, and they are the piece a first attempt misses: their
absence produces a shader that compiles with `syntax error, unexpected '}'`
where a fragment should be, not a missing-file error. The classes come from
`-lOgreNextHlmsUnlit -lOgreNextHlmsPbs`, not from `-lOgreNextMain`.

**What the headless gate can and cannot assert.** Under `RenderSystem_NULL`
everything through `createItem` works — mesh, both Hlms, both datablocks, the
item attach, the frame loop — and the readback cannot: there is no framebuffer
to download. Pixels require GL3+.

**llvmpipe runs the GL3+ render system on this Mesa.** With
`LIBGL_ALWAYS_SOFTWARE=1` against the existing display, OGRE brings the GL3+
RS up and renders (the run fails identically to the hardware path, on the same
shader bug, which is what proved the driver was never the variable). It is a
candidate CI substrate that needs no Xvfb.

**`SCENE` owns three sub-tables by convention.** The region is 256 KiB and
holds them end to end from its offset: 1024 × `SceneNode` (80 B), then 512 ×
`CameraRecord` (80 B), then 1024 × `LightRecord` (96 B) — 216 KiB of the 256,
with 40 KiB spare. The constants live in `assembly/ogre/wire.ts` and in
`tension_ogre.h`, because the guest has to know them to write a camera into the
right place. **This convention is not part of `layoutHash`**: the hash covers
the protocol's shape, and `SCENE`'s internal split is the capability's own
business. Adding a *region* would move the hash, bump `schemaVersion` and force
every guest to be rebuilt; this does none of that, which is the point.

**A `Renderable` is a self-placed leaf.** Its 64 bytes carry an inline
transform — position @16, rotation @32, scale @48 — and **no `nodeId`**. So a
renderable is placed by its own transform, and `SceneNode` exists for cameras,
lights and (later) hierarchy. The guest composes transforms before writing the
record; the adapter does not resolve a parent chain for a drawable.

**Materials for the first triangle are Unlit.** `MAT_HLMS_UNLIT` with
`setUseColour(true)` + `setColour(rgba)` is the milestone's path, and the
reason is physical rather than stylistic: **a PBS datablock with no light
renders black**, so a pixel assertion about "the material's colour" would need
a light rig that 3b does not have. PBS datablocks are creatable — the Hlms is
constructed and registered all the same — but nothing asserts how they look
until there is a light to see them by.

**Skinned meshes cannot use Unlit at all, and PBS needs two things to draw.**
Measured by `tests/probe_skinning.cpp` (chunk 5b), and the first of the two cost
this repo a whole round.

HlmsUnlit's shader templates contain **no skeletal-animation code**: a grep over
`Media/Hlms/Unlit/` for "bone" or "skeleton" returns nothing, while
`Media/Hlms/Pbs/Any/Main/800.VertexShader_piece_vs.any` carries an
`hlms_skeleton` block per vertex — `@property( hlms_skeleton )` around the bone
matrices, `@foreach( hlms_bones_per_vertex, n, 1 )` around the weights. HlmsUnlit
is, in its own class reference's words, the implementation *without lighting or
skeletal animation*. With an Unlit datablock the CPU-side skeleton is perfectly
correct and the GPU cannot see it: the probe posed a bone through seven
combinations and measured `flip 0.00000` for every one, while the bone's own
local transform demonstrably carried the pose (`w=0.707` as set). The joint is
that a *static* mesh renders under either Hlms, so the 3b choice of Unlit was
right and still left this trap: **the material family is part of the skinning
contract, and nothing reports it when it is wrong.** The shape that works with
no light rig is PBS with diffuse and specular zeroed and the colour in emissive.

A PBS datablock that is created, bound, and reported by the subitem as belonging
to hlms `"pbs"` can still draw **nothing at all** — silently. Two requirements,
both easy to miss, both measured:

- **A Forward+ light setup has to exist.** `SceneManager::setForwardClustered(
  true, 16, 8, 24, 96, 2, 0, 0.0f, 100000.0f )` immediately after
  `createSceneManager`, before the Hlms is constructed and before any datablock
  is made.
- **`HlmsPbs`'s library folders come from `HlmsPbs::getDefaultPaths()`**, never
  from a hand-written list. That call returns five folders; the last,
  `Hlms/Pbs/Any/Main`, holds the vertex-shader piece. A list that stops at
  `Hlms/Pbs/Any` — which is what the Unlit path needs, and what this probe did
  first — leaves PBS with **no vertex shader**: no exception, no log line, no
  failed-compile message, and 0 non-background pixels at every scale, for a
  plain `cube.mesh` as much as for a rigged character. `HlmsUnlit::getDefaultPaths()`
  is the same call for the Unlit path.

With both in place the PBS arm renders exactly what the Unlit arm did (174
non-background pixels at scale 0.2, 1574 at 0.6, the same blob) and the pose
starts moving it: a single 90° bone rotation flips 0.0197 of the frame at scale
0.6 (1504 px of silhouette to 1376, mean channel delta 1.68).

**The posing sequence: set the bone, nothing else.** `SkeletonInstance::getBone(i)`
-> `setPosition` / `setOrientation` / `setScale` is sufficient. The probe measured
seven combinations — with and without `setManualBone( bone, true )`, with and
without `skeleton->update()`, and in both orders — and **all seven render
identically** (`flip 0.02065`, the same number to five places, which is what a
pure function of state should produce). So `setManualBone` is not needed and is
not used: it takes a bone away from OGRE's animation system, which is a cost to
pay only if something demands it. `skeleton->update()` is still called after a
batch — it recomputes derived transforms immediately, at ~2.2-2.9 µs per frame
for 1-19 bones — but the rendered result does not depend on it.

Not every bone deforms the mesh. The probe's per-bone sweep at scale 0.6: bones
0-3 (`Hand_IK_L`, `Hand_IK_R`, `Foot_IK_L`, `Foot_IK_R`) give `flip 0.00000` —
they are IK leaves with no weighted geometry — while `Root`, `Pelvis`, `Spine`,
`Spine.001`, `Head` and `Arm_L` give `flip 0.030-0.036`. The acid test poses
`Spine` (index 6), the clearest of them at 0.03557.

**Textures, and the abort that was not about the render system.** Round 3a-i's
probe aborted inside `Ogre::Exception::~Exception` → `ObjCmdBuffer::clear()` when
a texture was scheduled to Resident, and the first conclusion — "GPU textures
are not possible under `RenderSystem_NULL`" — was **wrong**. The abort was
*invalid texture settings*: an `Image2` scheduled onto a `TextureGpu` whose
pixel format, texture type, mip count and resolution had never been set from
that image. With the settings taken from the image (the "manually fill"
sequence in OGRE's own docs) the same call works under **both** render systems:
round 3a-ii loads a 16×16 DDS under NULL and under GL3+ and renders frames with
it resident. The lesson is worth more than the limitation it replaced: an
exception thrown on OGRE's command-buffer path does not unwind — it aborts, so
the *first* failure a new call can produce is the one worth instrumenting.

What remains install-specific is the **codec**: this OGRE build registers DDS
and OITD and nothing else — no PNG, JPEG or TGA — so a PNG texture fails as a
*named job failure* (`Unable to identify codec`), not as a crash, and the
fixtures use DDS.

**How resources load.** OGRE-Next 3.0 ships its meshes in the *v1* format
(`[MeshSerializer_v1.8]`, 35 of them in `Media/models`), so a load uses two
managers: `v1::MeshSerializer::importMesh` parses the bytes into a v1 mesh, and
`MeshManager::createByImportingV1` converts it into the `Mesh2` the rest of the
engine wants. The conversion is deferred — a freshly converted `Mesh2` has no
submeshes until `load()` is called (measured: 0 then 1) — which is convenient
here, because it puts a clean boundary between "parse these bytes" and "make
GPU buffers". One more measured detail: the shipped meshes carry two bytes of
their own before the `[MeshSerializer` tag, so the loader's kind check *scans*
the file's opening rather than testing offset zero — a prefix test is wrong
about a file OGRE itself parses happily. Textures are already asynchronous inside OGRE: `TextureGpuManager`
runs its own documented background thread, so this adapter does not spawn a
second one for texture IO.

**The capability's import surface, as registered.** Nine verbs: `ogre::init`,
`ogre::shutdown`, `ogre::last_error`, `queue_mesh_load`, `queue_texture_load`,
`job_state`, `job_release`, `submit` (id 8) and `screenshot` (id 9, the
reentrant-readonly flag, as `last_error` and `job_state` carry). Registering a
verb the SDK declares but a guest never calls is harmless, and Binaryen drops
an unused import anyway (measured in 3b-i: seven declared, one called, one
import in the compiled module) — the registration is what lets a guest that
*does* call one link and instantiate.

**`ogre::screenshot(ptr, cap)` is probe/consume, like `last_error`.** `cap <= 0`
answers the byte count without copying; `cap > 0` copies `min(cap, len)` bytes
into the guest and consumes them. `-1` means no frame has been downloaded yet —
the normal answer for the first call or two. The image is tightly packed RGBA8,
top-left origin, at the window's own resolution. **A request asks for the next
frame's download and answers with the last one's**, so a guest asks at least one
frame ahead of the frame it wants to read.

**The download is an asynchronous ticket, and the swap is not a safe place to
read it.** `OgreWindow.h` documents two ways to take a picture. The obvious one
(`setWantsToDownload` + `setManualSwapRelease` + `renderOneFrame` +
`convertFromTexture` + `performManualRelease`) is what the scene probe used,
and it is racy inside a frame loop: measured over six runs of an idle session,
one run in five downloaded an all-black image, because the conversion reads the
window's texture while other frames are being drawn and swapped into it. The
header's documented alternative is the reliable one and is what the adapter
does: `setWantsToDownload(true)`, then convert inside a `FrameListener`'s
`frameRenderingQueued` — after the compositor has drawn the frame, before the
window swaps it away — checking `canDownloadData()` and leaving the request
pending for the next frame when the ticket is not ready. Six runs of the same
idle session under that path: six correct frames.

**`SceneMirror`'s removes are dirty-with-`live == false`.** One dirty list per
kind carries both "this record changed" and "this record is gone"; the `live`
flag distinguishes them, so `submit(kind, id, 1)` returns as soon as the mirror
has recorded the removal and the OGRE object is destroyed on the render
thread's *next* frame. The mirror is written by the guest thread (`submit`) and
read once a frame by the render thread, so the adapter holds a mutex across the
pair; the mirror itself stays lock-free, which is what lets its unit tests
drive it from one thread.

**A per-entry apply failure is logged and skipped, not fatal.** A record whose
OGRE call throws — a renderable naming a resource that is not a realised mesh,
a material whose Hlms was never registered — leaves the render loop running and
the frame drawing. The entry stays live in the mirror, so re-submitting the
same id is what retries it; there is no automatic retry, because a
deterministic failure would then re-log every frame.

**A shim's record buffer is sized by the *wire* record, not the decoder
struct.** The decoder structs are narrower than the records they decode —
`MaterialRecord` carries the fields this adapter reads through slot 0 and is 88
bytes, while the `MATERIAL` region's record is 208 — so a buffer sized from the
struct overflows by 56 bytes. That is not hypothetical: it presented as
`*** stack smashing detected ***` on the first `submitMaterial` the fixture
made.

**A renderable's mesh and a material's texture name resource ids, and only the
adapter knows both names.** The guest addresses a resource by the id the
`RESOURCE` region gave it; the backend realises it under a handle of its own
(`ResourceHandle`, 1-based, index 0 unused). `Backend::set_resource_lookup` is
that mapping, wired once at link time from the loader's table, and it is the
only reason `apply_submissions` can bind an `Item` to a `MeshPtr`.

**The motion table is chunk 4's batch path for transforms.** A table of 64-byte
`MotionUpdate` records sits at the start of `BUFFER_POOL` — a region that
existed, guest-written and 4 MiB, and that nothing had declared until now — and
one verb, `ogre::submit_motion(count)` (id 10, flags 0), names how much of it is
live. The guest writes N entries and makes **one** call per frame; the adapter
reads the whole table during that call. That removes N wasm→host transitions
per frame and leaves the one O(N) that cannot be amortized: N transforms must
reach N OGRE nodes. The record is `renderableId u32@0`, `flags u32@4`,
`pad0 u64@8`, then the transform at **16/32/48** — the same offsets
`Renderable`'s inline transform uses, with `pad0` being what puts a `Quatf` on a
16-byte boundary. Capacity is `min(RENDERABLE_COUNT, BUFFER_POOL_SIZE / 64)` =
2048. **The batch is all-or-nothing**: an entry naming a renderable the mirror
does not hold live refuses the whole call with `-ENOENT` and a log line naming
the index, because a half-applied frame is worse than a refused one.

**The bone table is chunk 5b's batch path for a rig.** A second table of
64-byte `BoneUpdate` records sits in `BUFFER_POOL` past the motion table
(`BONE_TABLE_OFFSET` = 128 KiB, so motion is the first 128 KiB and bones the
next), and one verb, `ogre::submit_bones(count)` (id 11, flags 0), names how
much of it is live. Same shape as motion, for the same reason: a rig poses many
bones per frame and wasm→host transitions are the part that does not have to be
O(N). The record is `renderableId u32@0`, `boneIndex u32@4`, `pad0 u64@8`, then
the transform at **16/32/48** — motion's layout with a bone index where `flags`
was. Capacity 2048. The batch is **all-or-nothing**, and validation asks the
loader rather than keeping its own copy of an answer only the loader has:
`renderableId` must be live, that renderable's mesh must be **rigged**, and
`boneIndex` must be inside that rig — `-ENOENT` and `-EINVAL`, naming the index
and the field, with nothing applied.

**A bone is not a scene node.** Bones are OGRE's own `SkeletonInstance::Bone`
— the rig `createItem` builds out of a rigged mesh's skeleton — and
deliberately not `SceneNode`s: a rig in the scene graph would be walked,
frustum-culled and destroyed like a scene object, which is the wrong layer for
something the guest addresses by index. OGRE-Next 3.0 has no
`Item::setSkeletonInstance` and needs none; `item->getSkeletonInstance()` is the
pointer the bone pass poses, and it is null for a static mesh.

**A rig costs one integer compare per frame.** The mirror holds the batch, its
count, and a **generation**; the render thread applies the table only when the
generation differs from the one it last applied, so a still rig is free. A
repeated batch still bumps it — the mirror records that a snapshot arrived, and
whether re-applying is worth anything is the render thread's question, not the
mirror's. What applying costs when it does happen: **2.2-2.9 µs per frame** for
a 19-bone rig (probe, 300 frames), against ~1.2 ms for a Forward+ frame.

**The rigged-resource flag, and the collision it exposed.** A mesh resource says
it is rigged in its `Resource` record's `flags` (bit 0, `RES_RIGGED`) and puts
its **bone count** in `size`, where other resources put bytes — that is
`isRigged` / `boneCount` for the guest, with no verb and no event. Writing those
fields exposed a latent bug worth recording here: resource ids are 1-based over
the `RESOURCE` region and **slot 1 is the renderer's own record**
(`TENSION_OGRE_RESOURCE_RENDERER` = 1), so the loader now allocates from 2 and
slot 1 keeps its meaning. The collision was invisible for four chunks because a
resource id was only ever an opaque handle; the first guest to read a resource
*field* read the renderer's record instead and was told the rigged mesh had no
rig.

**Hierarchy is the wire's `parentId`, and the composition is OGRE's.** Chunk 5
lifts 3b's refusal. The adapter does **not** compose world transforms: it maps
`SceneNode.parentId` onto `Ogre::SceneNode` parenting (`addChild`,
`removeFromParent`), and OGRE-Next's scene graph is the cache — setting a
parent's transform marks its descendants dirty, and the update pass walks them
in dependency order. The design's §12 note listed "cached world transforms
invalidated when a parent changes" as hierarchy's cost; that estimate was
written before this was checked, and the cache is the renderer's. What the
adapter owes instead is smaller and more precise:

- **Validation at submit** (mirror, guest thread): `parentId` is 0 or a live
  node; a node is never its own ancestor — the proposed chain is walked to the
  root and the node's own id on it is a cycle, refused `-EINVAL` with the chain
  logged; the cap is 32 links, and it applies to every chain the submission
  creates, so a re-parent is refused when the node's new depth plus the height
  of the subtree it carries would pass the cap.
- **Removal rules**: `remove_node` refuses `-EBUSY` while a live node names it
  as parent (the first child is logged), because a parent that dies under a
  live child is a dangling reference and OGRE would detach the child silently.
  The same rule covers renderables: a live renderable whose `nodeId` names the
  node refuses the removal, so a drawable is never "alive but unattached".
- **On-demand parent creation**: a child's record can arrive before its
  parent's, so the render thread walks the chain and creates any missing OGRE
  node from the mirror's records rather than sorting the dirty list by depth.

**`SceneNode.childCount` is derived, and a guest that writes it is refused.**
The mirror counts children; a submission with a non-zero `childCount` is
`-EINVAL` with the field named, because a field the guest fills with a guess is
worse than no field — the count is the mirror's answer, not the guest's claim.

**A renderable's `nodeId` is the field at offset 12, and its transform is then
local.** That word was `flags`, written by nobody and read by nobody but the
decoder (measured in round 5a, which is what made the repurposing safe): it is
now the id of the node the drawable hangs from, 0 meaning "self-placed at the
world root" as before. The semantics change and the shape does not, so
`layoutHash` stays where it is. With a parent, the renderable's inline
transform is relative to that node — which is also what a motion entry writes,
so **motion is local**: a body on a moving platform follows the platform for
free, and a guest that meant world coordinates must compose them itself.

**Motion targets renderables, not cameras or lights.** A camera driven by a
solver is a distinct feature with its own assertion — a follow-cam changes what
"the object moved" means — and chunk 4 does not have one.

**The motion read happens inside the import call, on the interpreter thread.**
The guest thread writes the table and calls `submit_motion`; the shim takes
`scene_mutex`, does **one** `guest_read` of `count × 64` bytes into host memory,
decodes, and applies each entry to the mirror. That is the only guest-memory
touch in the path, and it is in one of the three phases the ABI permits it
(`publish`, `apply`, an import call). Publish is not engaged at all: motion
writes nothing to guest memory, so the epoch's byte budget is untouched.
`SceneMirror::apply_motion` checks liveness only — the mesh and material were
validated when the renderable was submitted, and re-validating them sixty times
a second would be work for nobody.

**A motion entry is a whole transform, and the SDK's convenience must say so.**
The record carries position, rotation and scale, so an entry *replaces* the
renderable's transform: a guest that submitted a body at scale 0.02 and then
moved it through a helper that writes a unit scale silently resizes the body.
That is not hypothetical — it is the first thing the chunk-4 fixture did, and
it presents as a barrel filling the window rather than as a refusal, because the
protocol was obeyed and the guest lied. `MotionBatch.set` therefore takes the
scale explicitly (`scale: f32 = 1.0`), and a future rotation setter arrives the
same way: the value the guest does not name is the identity, never "whatever it
was before".

**A screenshot answers with the last *downloaded* frame, so a second read needs
a wait.** `ogre::screenshot` is probe/consume over the frame the render thread
last downloaded — not over "the frame right now". A guest that reads twice in a
row without letting the renderer advance gets the first read's pixels again,
which looks exactly like a scene that did not change: chunk 4's first visual run
reported a centroid delta of 0.0 px for a body the solver had moved, and the
frame it measured was the baseline. The rule for a guest that needs two frames:
arm the readback, wait for `frameCount()` to advance (three frames is
comfortable), then read. Recorded because the failure is silent and the
symptom is indistinguishable from a rendering bug.

**Measured: moving items every frame is cheap, so the batch removes calls rather
than work.** `tests/probe_motion.cpp`, GL3+ on this install: the per-frame
transform pass costs **1.6 µs at 64 items, 4.4 µs at 256, 12.2 µs at 1024**
(~12 ns per node), while `renderOneFrame()` costs 205–337 µs and is *not*
measurably slower in the moving phase than in a static one (256 items: 331 µs
moving against 344 µs static). Nothing is re-created — the scene holds 1024
children before and after — and the world AABB moves by exactly the transform's
delta. Chunk 4's ceiling is therefore the mirror walk and the guest's own loop,
not OGRE.

**`ogre::create_mesh` builds a mesh from guest-written buffers (chunk 5.5).**
Verbatim `12`, flags 0, synchronous: `create_mesh(vbOffset, vbBytes, format,
ibOffset, ibBytes, topology) -> resourceId`. The two arrays live in
`BUFFER_POOL` **past the bone table** — `PROCEDURAL_BASE` = 256 KiB (motion 128
KiB, bones the next 128 KiB) and `PROCEDURAL_CAPACITY` = 512 KiB, shared by both
buffers. That capacity is what makes a 16-bit index sufficient rather than a
limitation to design around: 512 KiB is ~43,000 vertices at 12 B, so no mesh
built this way can reach the 65,536th index. `topology` is 0
(`TOPO_TRIANGLE_LIST`) and nothing else yet; an unknown topology is `-EINVAL`.

**The vertex format is a flags word: `VF_POSITION`, `VF_NORMAL`, `VF_UV`.** The
adapter declares exactly the elements the flags name, in that order, so the
stride is derivable rather than a second parameter (12 B per vertex, plus 12 for
a normal and 8 for a uv). What an Unlit datablock *needs* was measured rather
than assumed: a constant-colour Unlit draw renders identically with position
alone, position+normal, and position+normal+uv — **10,368 pixels, mean rgb
229/51/51, all three** (probe, 320x240, camera at z=4). `VF_POSITION` is
therefore the only element required and the other two are the guest's business;
a textured datablock is where `VF_UV` would start to matter. Normals are carried
because a lit path needs them, not because this one does.

**The probe's first readback was the flaky part, and it looked like a format.**
Those three numbers come from a pull that repeats until the scene is in the
frame, because the single-frame pull the probe started with read 0 px in about
one measurement in fifteen — **on a different format each time**, which is what
identified the race rather than a requirement: a frame can be downloaded before
the item that was just created is in it. It is the same family as the
`screenshot` note below, one step earlier in the sequence. The probe now retries
(bounded, three frames between attempts) and **prints the attempt that worked**,
so a 0 after the whole budget is a real 0 rather than a slow frame; five
consecutive runs since have read every number on the first attempt.

**The construction sequence is the probe's, and one call in it is
load-bearing.** `v1::MeshManager::createManual(name, group)` takes no arrays —
it makes an empty v1 mesh whose submesh the guest's bytes fill by hand
(`createSubMesh`, a `VertexData` carrying a declaration and one interleaved
buffer, an `IndexData` carrying one 16-bit index buffer) — and then
`MeshManager::createByImportingV1` converts it to the Mesh2 the renderer draws,
exactly as the file path does. Two calls in that sequence are the serializer's
job for a file and the adapter's for a hand-built mesh:

- `prepareForShadowMapping(false)` is **required**. Without it the v1 mesh's
  `vertexData[VpShadow]` is null, `hasValidShadowMappingBuffers()` is false, and
  `SubMesh::importFromV1` takes the branch that imports a pass-1 buffer that
  does not exist: **SIGSEGV, measured in a child process** (probe variant
  `no-shadow`, exit 139).
- `_setBounds(box, false)` is recommended, not required: the same probe variant
  (`no-bounds`) converts *and* renders — 10,368 pixels, identical to the run
  with it — because an unset AABB behaves as infinite rather than empty. It is
  culling hygiene, and it is in the sequence because a mesh that is never culled
  is a scene that gets slower for reasons nobody can see.

**A submesh's material name must resolve, or the *PBS* Hlms must be
registered.** `Item`'s constructor ends in `Renderable::setMaterialName`, which
falls back to `HlmsManager::getDefaultDatablock()` when no `.material` script
defines the name — and that lookup indexes `mRegisteredHlms[mDefaultHlmsType]`
with `mDefaultHlmsType = HLMS_PBS` and no null check (`OgreHlmsManager.cpp:620`).
The first version of this probe registered Unlit alone and **segfaulted inside
`createItem`**; the adapter registers both Hlms for its own reasons and inherits
the protection by accident. Recorded because the failure names nothing and the
mesh is not what is wrong.

**The id exists before the mesh does, and the region is still the truth.**
`create_mesh` runs on the guest thread: it validates, reads the two buffers (one
`guest_read` each, chunk 4 and 5b's shape), allocates the resource id from the
loader's table and returns it. The render thread is the only thread that may
make an OGRE object, so realisation is deferred to the next loop iteration,
where it happens **before** `apply_submissions` in the same pass — a guest that
calls `create_mesh` and then `submitRenderable` with the id it got back is drawn
from the first frame. A realisation that fails writes the resource record's
`state`/`error` (`-EIO`, OGRE's message in the log) instead of failing the verb:
a guest learns this outcome the way it learns every other resource outcome, by
reading the region.

**Chunk 6 is guest-side physics, and the adapter does not change at all.** No
new verb, no wire record, no region, no `layout_hash` move: the solver is a
guest-facing capability, the contact math is game logic, and the renderer
already has the path it needs (`submit_motion`, 2048 entries, whole transforms).
What chunk 6 adds is a model, a thin SDK over it, and the acid test that says it
holds — stated here because a reader who expects a physics capability in the
adapter will otherwise look for something that is deliberately absent.

**The state model: six f64 per body — `[x, y, z, vx, vy, vz]` — in Verlet's
`[q, v]` split.** One solver holds every body (`dim = 6N`, so the 64 KiB
callback-buffer convention caps N at 1365) because a solver per body would
multiply the boundary crossings by N. Per-body parameters (radius, inverse mass,
restitution, friction) live in guest-side tables the derivative reads and never
integrates — the split `examples/solver/collision/game.ts` already uses.

**Verlet's state is NOT interleaved.** At system scale the layout is all N
positions followed by all N velocities:
`[x0,y0,z0, ..., xN,yN,zN, vx0,vy0,vz0, ..., vxN,vyN,vzN]`. Reading it as
per-body records launches bodies at nonsense velocities — chunk 6a's P1b did
exactly that and measured a body at 225 m/s with a 9.4 m penetration — and the
mistake is silent, because every index it reads is a valid index. The physics
SDK's accessors hide this from a user; a guest reading the raw state must know
it.

**Verlet is the integrator, and it was already there.** `GUEST_ABI.md` §7 said
`verlet` "returns -ENOSYS from create" and was wrong: P0 called
`create({method: "verlet", source: "wasm", dim: 6})` from a guest and stepped a
body dropped from y = 10 for 60 frames of 1/60 s — it landed at
5.094999999999969 against the closed form's 5.095, |Δ| = 3.1e-14, which is
velocity Verlet exactly. That is the integrator impulse physics wants:
fixed-step (every discontinuity lands on a step boundary rather than inside a
step), symplectic, and **two derivative evaluations per step against rk45's
seven** — measured at N = 256 (dim 1536): 1.4 µs per step for verlet against
31 µs for rk45, a factor of 22.

**The state channel is cheap, and writing it does not perturb the integral.**
Measured through the C ABI at dim 1536 (P1a): `state` 0.10 µs, `set_state`
0.11 µs, create+bind+destroy 0.86 µs, against a 1.4 µs step. The accuracy
question the design turned on is settled too: one body thrown upward for 60
steps — once untouched, once with a `state` + `set_state` every step, once with
the solver destroyed and recreated every step — reached an **apex of
5.094999999999996 in all three, a delta of 0.0 %** (P1b). Impulses may therefore
be written between steps with `set_state`: no solver churn, and no need for the
penalty-contact fallback the plan held in reserve. A frame's whole state channel
at N = 256 costs ~3 µs per sub-step.

**Contacts: spheres and planes, one impulse pass per sub-step, K = 4.**
Detection is guest-side and sphere-only — what a box of balls needs, with no
rotation in the narrow phase. The response is a normal impulse with restitution,
a tangential impulse clamped by μ, and a Baumgarte-style positional bias. One
pass, not an iterative solver, and the consequence is measured rather than
hidden: at 16 bodies (e = 0.3, μ = 0.4, β = 0.2) the deepest penetration is
**50 / 13 / 4 mm** and the residual jitter at frame 60 is **0.155 / 0.084 /
0.057 m/s** for **K = 1 / 2 / 4** — a pile creeps. K = 4 is what those numbers
argue for. Detection is brute force and affordable where the state cap allows:
**0.008 ms per pass at N = 16, 0.083 at 64, 1.17 at 256, 18.3 at 1024**, so the
crossover for a uniform grid sits around 256 and 1024 is where brute force stops
being an option.

**The SDK's lift is narrow: `World`, `Body`, `Contacts`, `resolve`.** No
integrators (the solver owns them), no joints, no CCD, no iteration, and no
broad-phase structure beyond what a probe shows is needed — the same shape
`MeshBuilder` and `BoneBatch` arrived in: an example earns it first.

**Sleeping is a measured policy, and its signal is displacement rather than
velocity.** A body sleeps when the average speed over a 30-frame window is below
`sleepSpeed` (0.1 m/s). Three measurements shaped that sentence, and all three
are recorded because each of them was a failing test first:

- The threshold is 0.1 because chunk 6's probe measured the pile's creep at
  **0.057 m/s** — a threshold at 0.05 would sleep nothing, and lowering it is
  not a tuning knob.
- The signal is the **displacement per frame**, not the stored velocity: a
  resting body's velocity carries the positional bias it was last pushed out
  by, which at a 4 mm penetration is ~0.14 m/s — above any sensible threshold,
  while the body goes nowhere at all. With the velocity as the signal, no body
  in the acid test's pile ever slept.
- The decision is the average over a **fixed** window, not a consecutive-frame
  count: an instantaneous signal reset the counter every 15-23 frames, and a
  window that a spike could reset never grew past 27, because a short window is
a noisy one and its average crosses the threshold. A body that is genuinely
  moving still never sleeps — its average over the whole window is its speed.

**The angular model gets a second signal, and it ships (8c1).** The decision is
linear displacement per frame **and** angular displacement per frame, both
averaged over the same 30-frame window: a body sleeps when both averages are
below their thresholds — `sleepSpeed` 0.1 m/s, `sleepAngularSpeed` **0.06 rad/s**
(0.001 rad per frame at 60 Hz). The threshold is grounded in chunk 8a's Q5, which
turned a resting box at most 0.0079 rad over 600 frames — **~1.3e-5 rad/frame** —
so it sits two orders of magnitude above the measured jitter and well below any
spin a viewer would call motion. Angular **displacement** is used rather than
`|ω|` for the same reason chunk 7 uses linear displacement rather than `|v|`:
raw angular velocity carries the positional bias the response last pushed the body
out by, while the angle between two frames is what "has this body stopped
turning?" actually means. The measurement is the shortest arc between the two
orientations, `2·acos(|dot(q_prev, q_now)|)`, with the absolute value handling
the quaternion double cover — `q` and `−q` are the same rotation, and the arc
must not go the long way round. The linear model evaluates neither the signal nor
its threshold, which is why chunk 6 and 7's numbers are unchanged to the last
digit. What the signal fixes, measured: a free body spun at 1 rad/s displaces
nothing at all, scored 0.0 m/s on the linear signal, slept at frame 30 and had
its spin zeroed with it — **0.5 rad of a second's turn**, which the unit test
pinned as a limitation in 8b and now asserts the fix for.

**Rolling resistance: the model, and the arithmetic that pinches its
coefficient.** A body that had a contact this sub-step has its spin decayed —
`ω ← ω · max(0, 1 − k·h)` — in the angular model only. One multiply and one
clamp per body per sub-step, rate-correct (`h` is the sub-step, so K and the
renderer's pacing cannot change it), and `k` is a rate in 1/s, which makes "the
spin decays with a 1/k second time constant" something a guest can read straight
off the number. The factor never reverses, so there is no chatter to clamp; the
decay is asymptotic rather than finite-time, which is fine here because the sleep
policy is a *threshold*, not an exact zero. **It is pure angular** — a torque
cannot move a body's centre of mass — and that is a correctness requirement
rather than a nicety: the sleep signal is *displacement*, so a resistance that
leaked into translation would keep awake the very pile it exists to settle. It
applies only when the body has a contact; a body in free space keeps its spin,
which is what makes a tumbling body in flight look like one.

Three clauses already in the chunk-8 acid test pinch `k` before anything is
chosen, and the arithmetic is worth writing down because the window is narrow.
The roller's total turn is `∫ω dt = ω₀/k` (7.16/k rad), so its **≥ 90° clause
needs k ≤ 4.5**. Reaching the 0.06 rad/s sleep threshold takes
`ln(7.16/0.06) = 4.78` time constants and the sleep window adds thirty frames, so
**asleep by frame 120 needs k ≥ ~3.2**. The spinner, dropped 0.55 m, turns 0.30
rad in the air plus `1/k` rad while decaying, so **its ≥ 30° clause needs
k ≲ 4**. The window is `k ∈ [3.2, 4.5]`; the plan's default is **3.6**, pending
the probe; and `0.0` disables the term and reproduces chunk 8c2 exactly. Whether
that window is real — and whether the spinner's contact is continuous enough for
the arithmetic to hold at all — is what the probe measures, and §12 carries what
moves if it comes back empty.

**The probe refuted that arithmetic, and the window is empty.** Three measurements,
each of which the estimate above got wrong in the same direction:

- **A resting body's contact is intermittent.** A body at rest settles at a
  penetration *inside* the slop, so the contact that the impulse path deliberately
  does not resolve is also the contact a damping pass keyed on "had a contact"
  does not see: measured, the spinner is in a *resolved* contact in **23.1 %** of
  its sub-steps after landing (261 of 1128), and the roller **24.7 %**. Keying the
  damping on a contact *candidate* — any contact at all, slop or not, a
  detection-side flag and not an impulse change — lifts that to **91.9 %** and
  **100 %**. Gate matters, and the probe measured both.
- **A rolling pair decays at 0.286·k, not k.** The term is pure angular, so it
  removes angular momentum and nothing else; friction then re-couples the spin to
  the linear momentum the term cannot touch, and the *pair* decays at
  `k·I/(I + m r²)` — **0.286·k** for a solid sphere. Measured against the closed
  form: at k = 4 the roller's rolling speed fell at ~1.18/s against the 4/s a
  spinner's decay shows. A free spinner decays at k; a roller crawls at a third
  of it.
- **Stopping the damping at the sleep threshold parks a body on it.** The plan's
  rule — skip a body already below `sleepAngularSpeed`, so a settled pile is not
  kept awake by the term's tail — stops the decay at exactly the number the sleep
  signal tests. Measured: the body parks just above it and never sleeps, and the
  pinch table read as a pass until the probe was taught that "never stopped" is
  the smallest margin rather than the largest. Dropping the rule (damping runs
  until the body sleeps, which is safe: a term that only *removes* motion cannot
  keep anything awake) removes the parking and costs nothing.

With those three, the clauses' real requirements are: the roller's ≥ 90° turn
needs **k ≤ 14.5**, "asleep by frame 120" needs **k ≥ 12**, and the spinner's
≥ 30° turn needs **k ≤ 7.8**. The window is empty by a factor of 1.5, and 9a-i
stops here rather than choosing. §12 carries what would have to move, measured:
at the smallest k the roller's clause allows, the spinner turns 26.7° against the
30° it asks for — 11 % short — and every other lever is larger.

**Rolling resistance as delivered: `k = 13`, on a contact candidate, with no
parking rule.** The term is `ω ← ω · max(0, 1 − k·h)` per sub-step for any body
with a contact **candidate** this sub-step, in the angular model only.
`WorldConfig.rollResistance` is the coefficient in 1/s and `0.0` disables it.

Three corrections from the probe moved it, and all three are in the code because
of what it measured:

- **Candidate, not resolved.** The impulse path skips contacts within the slop —
  deliberately, that is what the slop is for — and a body at rest settles at a
  penetration *inside* it. A damping pass keyed on *resolved* contacts therefore
  sees a resting body in **23 %** of its sub-steps; keyed on candidates, it sees
  **92–100 %**. The gate is one byte per body, written by the same loops in
  `Contacts` that generate the contacts, and it changes no impulse.
- **The coupling is real and it is `I/(I + m r²) = 2/7`.** A pure-angular term
  cannot touch linear momentum, so friction re-couples a roller's spin to its
  motion and the *pair* decays at `k·I/(I+mr²)` — a roller needs 3.5× the `k` a
  free spinner does for the same decay. That is exact arithmetic the plan's
  window ignored, and it is why the coefficient is 13 and not 3.6.
- **No parking rule.** The plan skipped damping for bodies below
  `sleepAngularSpeed`, so a settled pile would not be kept awake by the term's
  tail. Measured: that stops the decay at exactly the number the sleep signal
  tests, and the body parks just above it and never sleeps. The rule is gone — a
  term that only *removes* motion cannot keep anything awake — and the sleep
  policy remains the only thing that decides when a body is still.

**The light path is implemented end to end and has never been exercised.**
Recorded before chunk 10's probe ran, because it changes what the round is:

- `LightRecord` (96 B) is mirrored exactly — `kLightRecordBytes = 96`,
  `kLightCapacity = 1024`, the table at `kLightTableOffset`, and the wire's
  `SCENE_LIGHT_COUNT`/`SCENE_LIGHT_SIZE` agree with both.
- The adapter decodes it on the **generic submit verb** (`case kSubmitLight` →
  `decode_light_at` → `SceneMirror::upsert_light`), which already validates
  `kind ≤ 2`. The SDK's `submitLight` is a `submitRaw(SUBMIT_LIGHT, …)` — no
  dedicated import, one verb with a table kind.
- `apply_submissions` calls `apply_lights` **in the right place**: nodes →
  cameras → lights → materials → renderables → bones.
- `apply_lights` creates the Ogre light, sets type (directional/point/spot),
  diffuse **and specular** colour, `setPowerScale(intensity)`, attenuation from
  `range` for placed lights, attaches it to a `SCENE_DYNAMIC` node, sets the
  node's position and the light's direction — and it attaches *before* setting
  the direction, which is what `createLight()`'s own documentation demands.
- `setForwardClustered(true, 16, 8, 24, 96, 2, 0, 0.0f, 100000.0f)` matches the
  installed `OgreSceneManager.h` signature argument for argument: 16×8×24
  froxels, **96 lights per cell**, near 0, far 100000. It was never a minimum
  call to make PBS shaders generate — it is configured for lights.
- `apply_material_values` passes diffuse, specular *and* emissive through
  unconditionally for PBS. **The "PBS renders black" workaround is guest-side**:
  the fixtures and examples set `diffuse = 0` and put their colour in emissive.

And the two facts that make this a **prove-or-refute round rather than a wiring
round**: no fixture or example has ever called `submitLight` (the only references
in the repo are the adapter, the mirror and the backend), and every PBS material
in the repo has a zero diffuse — so even a perfect light would multiply nothing.
The first deliverable is a probe that answers *why nothing is lit*, and the
standing suspect is not the adapter: it is that nobody has ever asked it to
light anything.

**What the probe measured, in the order it matters.** The path works, and the
things it needs are more than the round assumed:

- **The shading exists and the archive list is complete.** Q9 checked all six
  paths `HlmsPbs::getDefaultPaths()` returns — the data folder `Hlms/Pbs/GLSL`
  and five library folders, `Hlms/Pbs/Any/Main` among them — and all are
  present. No folder is missing this time.
- **A PBS datablock with diffuse, specular and *zero* emissive shades.** Lit
  half mean **217.6** against dark half **39.9** at intensity 20 (**ratio 5.45**),
  with the mid band at **152.9** between them and the profile monotone across
  the surface (`0 0 0 0.2 5.7 13.4 20.7 25.3` at intensity 1, where nothing
  clips). With the light off the same surface is **mean 0.00**: pure black, which
  is what "no light" means with no ambient in scope.
- **The intensity scalar is a power scale, and 1.0 is far too dim to be
  usable.** `LightRecord.intensity` maps straight to `setPowerScale`; it is not
  normalised to 1.0, and the wire's default of 1 renders a lit surface almost
  black — a white light at 1.0 lights a 0.8-diffuse surface to a brightest
  pixel of **26/255**. The probe's ratio table, lit half / dark half on the same
  surface: **1.0 → 19.67 / 2.09 (ratio 9.40)**; **20 → 217.58 / 39.90 (ratio
  5.45)**, the row the fixture and the examples are written against; **100 →
  255.00 / 87.68 (ratio 2.91)**, where saturation clips the lit half and
  *compresses* the ratio — a brighter light is not a stronger shading test.
  Examples submit tens, not ones.
- **A light needs a scene node, and a dynamic one.** No node: **SIGSEGV**, no
  exception and no log line. A `SCENE_STATIC` node: `InvalidParametersException`
  — "Object is static while Node isn't, or viceversa" — because `createLight()`
  makes the light dynamic. The backend's `SCENE_DYNAMIC` choice is therefore not
  a style, it is the only thing that works, and the header's
  attach-before-setDirection rule is satisfied by it: in this version
  direction-first produces the *same* frame (mean 217.58 / 39.90 either way), so
  the rule is cheap insurance rather than a hard requirement.
- **Forward+ needed nothing beyond chunk 5b's call.** `lightsPerCell = 1`
  produces a byte-identical frame to 96 at one light; a second
  `setForwardClustered` call is a no-op; a point light parked at y = 200000,
  beyond the 100000 far plane, contributes nothing (silently, as it should — no
  exception, no log line); and the frame cost is flat for the first light
  (**2384 µs at 0 lights, 2378 at 1**) and +13 % at four (**2700**).
- **The no-light fallback holds.** An emissive-only PBS material and an Unlit
  material are **byte-identical with and without a light in the scene**, over
  their own pixel regions: the regression clause that keeps walking-stickman and
  the angular bouncing-bodies unchanged is satisfied, and **no LIT flag is
  needed**.
- **The skinned path shades**: Stickman under a lit PBS datablock turns a
  lit/dark ratio of **2.32** (the mesh is not a sphere, so it is coarse).
- **Two mesh traps, both SIGSEGVs with no diagnostic**, found by walking into
  them: `Smiley.mesh` ships with a skeleton, and importing it without a
  reachable skeleton leaves the PBS vertex shader reading bone matrices nobody
  filled (`HlmsPbs::fillBuffersForV2`); and a hand-built Mesh2 has no file, so
  `Mesh2::load()` sends the importer back to the resource manager for a v1 mesh
  that is not on disk (`v1::Mesh::calculateSize` on null). Both the probe and
  10b's fixture measure with `Barrel.mesh` — file-backed, unrigged, curved,
  bounding radius **4.8555** (read off the v1 side), scaled by **0.2060** to
  radius 1, which puts one world unit at the camera's six units of depth at
  48.3 px. Stated so the next probe does not rediscover the two traps by
  walking into them.
- **Shadows are off explicitly, and the flag is the adapter's.** A light casts
  shadows by default and the adapter's workspace has no shadow node; the probe
  set `setCastShadows(false)` by hand on every light it made, which is not a
  measurement the adapter could inherit. **10b sets it in `apply_lights`, once,
  at creation** — the frame renders identically with it, and the point is
  explicitness: a future shadow chunk flips that one call and knows where the
  light-space matrix and the depth buffer have to go. (Whether shadows-on with
  no shadow node is fatal was never measured — the probe's first crash was the
  mesh — and it does not need to be: a scene with no shadow pipeline should not
  be asking.)

**The material rule, stated once.** The adapter writes diffuse and specular
unconditionally for a PBS record. **No LIT flag and no new material kind**: a
guest that wants a lit surface writes diffuse and specular, and a guest that
wants an emissive-only surface keeps diffuse at zero and uses emissive. The
existing emissive materials — walking-stickman's body and `bouncing-bodies
--angular`'s — were a **regression clause until 10b deliberately lit them**;
what carries the clause now is the fixture's own emissive-only surface, and the
rule it still enforces is that a light must not alter an emissive-only or Unlit
material's pixels:
chunk 10's probe measures exactly that (an emissive-only PBS material and an
Unlit material, with and without a light in the scene).

**Sleeping lives in the derivative mask, and it is not an optimization.** One
solver integrates the whole state vector; there is no per-body stepping and this
layer does not add one. The World zeroes a body's velocity when it sleeps and
hands the derivative a mask, which writes zeros in both halves for a sleeping
body — no gravity, no position derivative. Verlet then leaves the position
bit-for-bit unchanged, which is what makes the acid test's "the state at 240
equals the state at 210" an equality rather than a tolerance. The mask is module
state, like gravity: set before a step, cleared after, constant within one. The
solver still visits every slot, so sleeping is a **numerical and visual**
feature — the pile stops — and the only work it saves is the pair loop's
"both asleep" skip: one array read per pair, per sub-step.

**The wake list, and the one intentional asymmetry.** A sleeping body wakes when
an awake body touches it (in `resolve`, before the impulse is applied), or when
the caller says so: `wake`, `wakeAll`, `place`, `setVelocity`, `setParams`. Raw
writes through `Body`'s accessors do **not** wake — they are views over the
state vector and cannot be observed — and that is the one place this API can
surprise a caller, so it is stated on the class.

**The zeroing has to reach the solver.** The sleep decision runs at the end of a
`step` call, after the loop's last `set_state`; without one more write-back the
zeroed velocities never leave the buffer. Measured, before that write existed:
every body asleep, kinetic energy 0.0044 instead of 0 — sleepers holding the
last velocity they had, frozen but not zero.

**The motion wire has carried a rotation since chunk 4.** `MotionUpdate`'s
transform is a whole one — position at 16, rotation at 32, scale at 48 — and the
adapter applies it (`node->setOrientation(Ogre::Quaternion(record->rw, rx, ry,
rz))` in the apply path). That is why a guest frame naming a rotation has always
worked, and why chunk 8's angular dynamics is entirely guest-side: the rendering
path already knows about orientation, and the only things missing are a
`MotionBatch` writer and the dynamics themselves. No adapter, wire or session
change is implied by tumbling bodies.

**Chunk 8's angular state is fourteen f64 per body, and the integrator decides
its shape.** The state stays `[coordinates | derivatives]` in Verlet's split —
the first half every body's generalized coordinates, the second half their time
derivatives — at seven slots each: coordinates `[x, y, z, qx, qy, qz, qw]`,
derivatives `[vx, vy, vz, q'x, q'y, q'z, q'w]`, so `dim = 14N` with no padding
slot. The second half holds **q' = ½ω⊗q**, the quaternion's derivative, *not* the
angular velocity. That is the one thing the 8a probe changed about this design,
and the failure it avoids has no error message anywhere:

`tension_solver_symplectic.f90` is a **second-order** Verlet for `q'' = a`: its
position update is `q += dt·v_state + ½dt²·a_rhs`, reading the velocity from the
*state's* second half and the acceleration from the *RHS's* second half. **It
never reads the RHS's first half.** The ERK family is first-order (`y += dt·k1`)
and does; the symplectic family does not, and chunk 6's linear model satisfied it
only because positions and velocities happen to be exactly a second-order pair.
A state carrying `ω` where the solver expects `dq/dt` is integrated as
`q += dt·ω` — measured: a body spun at 1 rad/s for one second came out at
**1.5708 rad with |q| = 1.41421** (√2) instead of 1 rad and 1.00000. The
`[., ωx, ωy, ωz, pad]` layout this design first proposed is therefore wrong, and
its RHS — a perfectly correct-looking `q' = ½ω⊗q` written into the half the
solver ignores — is what hides it.

With the derivative form the RHS is `[v, q' | a, q'']` and is the *same function*
for both families: Verlet reads the second half, rk45 both. For a torque-free
body the second derivative collapses to a scalar multiple of the coordinate,
`q'' = ½ω⊗q' = −(|q'|²/|q|²)·q`, so the quaternion costs no products at all —
P1a measures that form at **3.4 µs per step against 7.4 µs** for the two-product
version at N = 256. ω is recovered from the state's own pair (`ω = 2q'⊗q⁻¹`)
whenever contacts need it, so nothing lives outside the state: `set_state` still
means what it says, and the region is still the truth.

Cost and cap, measured (P1a, N = 256, dim 3584): the angular step is **3.4–3.6 µs
against the linear model's 1.33–1.39 µs — 2.4–2.7×, where the slot count predicts
14/6 = 2.33×** — with `state` and `set_state` at **0.46 µs** (4.6× their linear
cost) and two evaluations per step. The 64 KiB callback-buffer convention that
gives the linear model N ≤ 1365 gives this one **N ≤ 585** (8192 f64 slots / 14).
`WorldConfig.angular` opts in; `angular = false` stays the default, because the
linear model is what chunk 6's state-write regression and the 1365 cap are
measured against, and a guest that does not want tumbling should not pay 2.4× the
state for it. The two models share the accessors, the contact generator, the
cadence and the tests.

**dim = 14N is accepted, and the evenness check is in the step, not the create.**
Asked both ways in the probe: a guest's `create(method: "verlet", dim: 224)` and
a direct call both return a live solver, and a step at dim = 7 returns **−22**
(`-EINVAL`) while a step at dim = 14 returns 0 with `status = 2`. That is by
design — `verlet_workspace_size`'s comment says evenness is the step's business —
but it means a guest cannot learn about an odd dim from `create` alone, and the
fallback path (rk45 at the same dim) accepts it too.

**The angular impulse, and the two wirings of the position bias.** At a contact
point `p` with unit normal `n` and `r_a = p − centre_a`, the contact-point
velocity is `v_p = v + ω × r`, and the normal impulse is

```
j_n = (desired − v_p·n) / ( invM_a + invM_b
                           + n·((I⁻¹_a (r_a × n)) × r_a)
                           + n·((I⁻¹_b (r_b × n)) × r_b) )
```

applied as `v += j_n · invM · n` and `ω += I⁻¹ (r × j_n n)`. Friction is the same
form on the tangential direction, clamped by `μ · j_n`. `I` is **diagonal** —
per-axis moments, exact for a sphere and for a box about its axes; a full tensor
is §12. The position bias is applied as a **linear-only velocity change and never
through the impulse**: `desired` above is `max(0, −e · v_p·n)`, and the bias term
does not enter `j_n`. Measured in the configuration that isolates it — one box
corner, 2 mm of penetration, no gravity, zero relative velocity, 300 frames at
K = 4 — the rule accumulates **exactly 0.0 rad** of rotation and the folded
wiring accumulates **0.0356 rad (2.04°)**: an angular impulse from a positional
correction is a torque with no force behind it, and a resting body turns on it.
The bias keeps its 1.0 m/s cap.

**A resting box creeps, and the sleeping policy is what ends it.** 600 frames of
a box resting on four corner contacts at K = 4, the rule applied (measured): the
box turns at most **2–16 mrad**, drifts **0.044 m** (one sequential pass) to
**0.159 m** (two passes) horizontally, and its energy varies by **0.34 %**. With
friction switched off the drift falls to **0.007 m**, so the wander is the
friction impulses at the corners, each computed against a state the previous
contact has already changed. A Jacobi pass — every normal impulse solved against
the pre-pass velocities and applied together — does **not** remove it (0.116 m),
which is worth knowing before someone reaches for it as the fix. What ends the
creep is chunk 7's policy: the drift is **0.0044 m/s**, more than an order of
magnitude under the 0.1 m/s threshold, so a settled box sleeps inside the 30-frame
window and the pile becomes exactly still. That is why §14's chunk-8 clause
asserts rest *through the sleep policy* rather than by waiting for physical rest,
and why the clause's "no motion" assertions are equalities rather than
tolerances.

**What the layer ships, and what it does not.** `WorldConfig.angular` is the
opt-in (8b): the state model above, the impulse formula above, friction that
carries a torque, and a `MotionBatch.setPose` for the orientation the simulation
now has. Three boundaries are worth naming because they are choices rather than
gaps: the **collider set does not change** — spheres and planes, so a body with a
box's inertia still touches the world at a point on the line of its centre, which
means a normal impulse can never spin it and friction is what does; the **inertia
is the diagonal applied in world axes**, exact for a sphere and the
simplification the probe's numbers are for; and the **sleep signal is still
linear displacement**, which is why a body spinning in place sleeps (§12 carries
the refinement, and the unit tests pin the measurement). What the model does
carry is the two measured rules: the bias is linear-only, and the quaternion
write-back renormalizes and rewrites `q' = ½ω⊗q` every sub-step — measured at
0.00014 % of drift against a 0.1 % budget, against bit-identical for a verbatim
write.

`ArenaControl` (256 B) is unchanged from the earlier rounds: `magic u64@0` (ASCII
`TNSARENA`), `formatVersion u16@8`, `schemaVersion u16@10`, `abiVersion u16@12`,
`flags u16@14`, `totalSize u32@16`, `layoutHash u32@20`, `regionCount u32@24`,
`regionTableOff u32@28`, `manifestOff u32@32`, `manifestLen u32@36`, reserved to
160, then the session-owned tail: `state u32@160`, `faultCode i32@164`,
`faultDetail u32@168`, `sessionNonce u64@176`.

`SessionInfo` (128 B) is not merely reserved — it publishes the session's
constants so a guest can cross-check its build at startup: `magic u64`,
`abiVersion u16`, `schemaVersion u16`, `flags u32`, `arenaSize`,
`maxArenaSize`, `memoryBase`, `initialPages`, `maxPages`, `layoutHash`,
`regionCount`, `classCount`, `classCapacity[10]`, `openNonce u64`, reserved.

**The adapter mounts Tension Volumes, and the loader reads meshes and textures
from them (chunk 11, round 11a's probes).** `ogre::mount_tns(prefix, tns_path)`
reads both strings from the STRING arena, opens `tns_path` — always absolute,
the adapter does not resolve relative paths — reads it into memory and calls
`tension_res_load_borrowed`, pushing `{prefix, tns_path, bytes, handle}` onto
the mount table. `queue_mesh_load` and `queue_texture_load` resolve through the
table: **longest prefix wins**, the path after the strip carries no leading `/`,
`"<prefix>/"` alone is `-EINVAL`, and a job whose path no mount matches fails
**deferred** with `-ENOENT` — the same shape the existing guest-jobs test
asserts — with a queue-time log line distinguishing "no mount matched" from
"not in the matched mount". The C ABI is the right shape for this seam: the
caller owns the bytes and the library never opens a file. The header's one C++ defect is fixed (11b): the
typedef `tension_res_stat` and the function of the same name collided in the
ordinary identifier namespace — invisible to Rust's FFI and Zig's cImport, and
fatal to the first C++ consumer this ABI has ever had. The function is
`tension_res_stat_path` now, and `tests/probe_tns.cpp` includes the real header
with no local declarations. The probe measures the
read path against the shipping archive: `text/intro.txt` (313 B) and
`data/level1.bin` (4096 B, the multi-chunk file) read byte-exact through
`load_borrowed`/`open`/`stat_fd`/`read`/`close`, `-2` for a missing path, and a
50,688-byte scratch volume loads borrowed in 51.8 µs; a 94,025-byte mesh reads
in **946.6 µs through the volume against 158.2 µs from disk — 6.0×** — because
the volume arm pays Deflate (the packer compressed the same bytes into
50,688 B). Per mesh at load time that is nothing beside the disk arm's
syscalls; a round that wants the raw path wants a packer "stored" switch, not a
loader change.

**The loader's byte source, as delivered (11b).** `mounts.{h,cpp}` holds the
table: `Mount { prefix, tns_path, bytes, res }` in a heap-stable `unique_ptr`
vector — stable so a resolved `const Mount *` outlives the lock that found it,
append-only so there is nothing to invalidate. The verb is `mount_tns`, **verb
id 13** (the plan said 12; `create_mesh` already held 12, and a second verb on
one id would shadow it): four `i32` arguments, registered beside the rest, and
the surface test now counts thirteen imports. The worker resolves by longest
prefix, reads through `tension_res_open`/`stat_fd`/`read`/`close`, keeps the
magic check and the completion push; no mount matches → `-ENOENT` ("no mount
for <path>"), and a path that ends in `/` → `-EINVAL` (a directory is not a
file). The render side is untouched: same queue, same `MemoryDataStream`, same
`MeshSerializer::importMesh`. The DSO links the same static archive
`tension-core` links — measured 3,504,488 → 4,443,544 bytes (+26.8 %), with
`--exclude-libs,ALL` keeping the archive's exported symbols out of the DSO's
dynamic table.

**A skeleton can be fileless, and the probe proved it (11a Q2).** With **no
resource location registered at all** — and a group created *empty*, which is
itself a requirement: a resource cannot be created in a group that does not
exist (`ItemIdentityException` from `isResourceGroupInitialised`; the adapter's
group exists today only as a side effect of `addResourceLocation`) — the
sequence is: read the skeleton bytes, create the resource as
`v1::OldSkeletonManager::create(name, group, /*isManual*/true, loader)` whose
`loadResource` runs `v1::SkeletonSerializer::importSkeleton` on a
`MemoryDataStream` over those bytes, then import the mesh exactly as
`realise_mesh` does. The conversion's own lookup **fires the loader** (measured:
`loadResource` 0 → 1 across `mesh->load()`, `isLoaded` yes), so no preload step
is needed, and `SkeletonManager::getSkeletonDef(name, group)` resolves from the
same manual resource when asked directly. Stickman comes back with
`hasSkeleton=true, bones=19`, an item `SkeletonInstance` of 19 bones, and the
skinning is visible: posing `Pelvis` 30° moves the figure from 3629 to 8355
silhouette pixels, flip **0.11294**. One trap earns its ink: the **name must be
exactly the mesh's own reference** — `getSkeletonName()` returns
`"Stickman.skeleton"`, and registering `"Stickman"` yields `hasSkeleton=true`
with a **null def and no exception** (measured, first arm); the no-registration
control arm lands in the same silent state, which is chunk 5b's SIGSEGV class
waiting for the draw. The manual-registration policy is therefore taken: no
partial migration, no `Ogre::Archive` subclass, and 11b's loader needs no
resource location for meshes or skeletons.

**As delivered (11b): the sibling convention, and four measurements the 11a
plan did not have.** The shipped v1 meshes are *binary*
(`[MeshSerializer_v1.100]`), not XML — there is no `<skeletonlink name="...">`
text for the worker to scan, and the plan's tag does not exist in the files.
What the round measured instead, one trap at a time:

1. The v1 importer *captures* the skeleton resource it finds at **import**
   time. Registering the manual resource after `importMesh` — the plan's order —
   replaces a resource the mesh already holds, and the conversion then builds a
   def with **0 bones on a 19-bone rig** (measured twice, in two orders).
2. The importer also *declares* a skeleton resource the moment it parses a
   linking mesh: an empty shell under the right name, no loader behind it. "A
   resource with this name exists" is therefore the wrong test; "is it loaded,
   and is it ours" is the right one, and the backend replaces shells.
3. With the media `models` location still registered, the import loaded
   `Stickman.skeleton` **from the OGRE install on disk** — the mounted volume
   was decoration. That location now retires in `add_resource_locations`; the
   volume is the only source of a skeleton, no disk fallback.
4. `initialiseResourceGroup(kResourceGroup, false)` — the round's plan's way to
   satisfy the probe's group-state finding — is an unconditional **SIGSEGV at
   startup** in this adapter: initialising "General" parses every script in the
   media tree, and one of them dies inside
   `UnifiedHighLevelGpuProgram::createParameters` under the NULL render system.
   It is not called. The default group is already initialised, which is the
   state manual resources check (the probe's missing-group finding was about a
   group that did not exist at all, and it lives on in `mount_tns`'s world).

The delivered sequence: the loader derives the sibling name from the mesh's own
path (`resources/models/x.mesh` → `x.skeleton`), reads it through the mount
table (the per-job `AssetResolver`, same lock as the worker's) and hands it to
the backend **before** the import; `realise_mesh` registers it as a manual v1
resource under exactly the name the mesh references and keeps its loader alive,
then imports. If the parse still reports a skeleton the candidate did not
cover, the resolver gets one chance; if the volume does not carry it, the job
fails `-ENOENT`. And a mesh that comes back rigged with a null def is refused
`-ENOENT` rather than drawn — that state is chunk 5b's SIGSEGV class. Textures
read through the same volume path; the upload half is unchanged by the source
swap.

**Thread rule for the mount table, as implemented.** One `tension_res*` per
mount; every call into it — the guest thread's mount, the worker's read, the
render thread's sibling read — happens under the loader's job-table mutex. The C header states no thread-safety guarantee and the handle
carries mutable state (fd table, readdir cursor); if a future round needs two
readers, the ABI's own answer is `tension_res_load_borrowed` twice over the same
immutable bytes, which yields two independent handles.

### 5.2 Region kinds — the twelve, frozen

| kind | region | default size | writes |
| --- | --- | --- | --- |
| 0 | `CONTROL` | 256 B | session, once |
| 1 | `SESSION_INFO` | 128 B | session, once |
| 2 | `FRAME_STATE` | 4 KiB | session |
| 3 | `JOB` | 48 KiB | session |
| 4 | `RESOURCE` | 48 KiB | session |
| 5 | `EVENT_TABLE` | 384 KiB | session |
| 6 | `STRING` | 1 MiB + 32 B | both halves |
| 7 | `RESOURCE_REQ` | 48 KiB | guest |
| 8 | `SCENE` | 256 KiB | guest |
| 9 | `MATERIAL` | 64 KiB | guest |
| 10 | `RENDERABLE` | 128 KiB | guest |
| 11 | `BUFFER_POOL` | 4 MiB | guest |

Default reserved total: 4 KiB header page + 6100 KiB of regions ≈ 5.96 MiB,
inside an 8 MiB `max_arena_size`.

**Chunk 1's region table is fixed-layout.** A capability adapter cannot add,
move, or resize a region; `region_lookup` returns `-ENOENT` for any kind
outside the twelve. A future capability that needs its own region requires
either a **schema bump** (a shape change: `layoutHash` and `schemaVersion`
both move, and every capability recompiles) or a **dynamic region allocation
mechanism** (an `allocate_region` verb and a directory, which forfeits the O(1)
`kind == index` lookup and forfeits compile-time offsets for `region_lookup` at
link time). Chunk 1 takes neither, deliberately.

### 5.3 `RegionDesc` and the guest's O(1) lookup

Entry, 24 B: `kind u32@0`, `flags u32@4`, `offset u32@8`, `size u32@12`,
`align u32@16`, `reserved u32@20`. Direction bits in `flags`: `RD_GUEST_WRITES`
(1), `RD_SESSION_WRITES` (2), `RD_WRITES_ONCE` (4), `RD_BYTES` (8).

**Kind == index.** The session writes entries in ascending kind order at
`0x200 + kind*24`, so the guest's lookup is arithmetic, not a search:
`changetype<RegionDesc>(0x200 + kind * 24)`. The `kind` field is an assertion
the SDK can verify once at startup. There is no `session_get_region` and no
`session_request_region` verb.

Every session verb entry re-reads `magic`, `layoutHash` and `regionCount` and
(re)checksums the region table against the copy in `SessionInfo`, so a guest
that writes into the header page produces `FAULTED` and `-EIO` rather than
being followed into the weeds.

### 5.4 Canaries — what they detect, and what they do not

The reserved gap `[layout_end, memory_base)` is guarded by a sparse canary
lattice: a 16-byte block every 4 KiB, carrying `(offset ^ magic)` and its
complement, so a shifted write is not accidentally correct. A mismatch at any
check means `FAULTED`, `faultState = FAULT_GUEST_OVERLAP`, a named
`[tension:session]` diagnostic, and `-EIO`. The lattice **does not cover the
always-arena range**: the session writes the header page itself and publishes
into the region band later, so a lattice there would report the session's own
work as corruption.

The always-arena range `[0, layout_end)` is protected by two other mechanisms,
and it is worth being precise about which case each one covers:

- **The control-block triple** — `magic`, `layoutHash`, `regionCount`, re-read
  at every verb and epoch entry — detects a guest that overwrites the arena's
  own metadata, at any point in the session's life. It is the *runtime*
  detector for the header page.
- **The pre-`_start_game` full-band zero sweep** — the session zeroes the whole
  band the module claims *before* instantiation, and verifies that
  `[header_page, layout_end)` is still all zero after instantiation and before
  the guest's first instruction. That is a *complete* test for the startup
  case: a data segment landing anywhere in the region band leaves a nonzero
  byte, and the zero baseline is what makes the negative check meaningful.

So the startup case for the always-arena range is deterministic (the sweep) and
its runtime case is sampled (the triple); the gap's startup *and* runtime case
are the lattice, which samples rather than proves.

Cost at the default ceiling: the gap is 2,138,080 bytes, so the lattice is 521
blocks — 8,336 bytes of arena — with 521 comparisons at startup and sixteen
loads per later entry. (The region band's sweep is cheaper *and* complete, which
is why it, not a lattice, guards that range.)

The honest limitation, which belongs in the header rather than in a footnote: a
wild pointer that writes outside every canary block between two checks is not
detected until it lands on one. Canaries make the common `memoryBase` drift and
the common bump-pointer march loud and fast; they do not make overlap
impossible. The hard guarantee is the build pipeline (§10), and the real fix —
a second wasm memory for the arena, so isolation is structural — is blocked by
the guest toolchain rather than by the runtime: wasmtime 24.0.13 enables the
multi-memory proposal by default (probe-confirmed, §13), while AssemblyScript
0.28.8 emits and addresses one linear memory.

## 6. `session_open`

### 6.1 The TLV

Flat little-endian key/value stream with **`u32` keys**: the entry count as a
`u32`, then per entry a `u32` key, a `u8` tag, and the payload. Every value is
carried by tag 2 (an `i64`, little-endian) whose **upper four bytes must be
zero**, so a value that does not fit a `u32` is refused rather than truncated.
`abi_version` must be the **first entry in the byte stream** — the decoder
enforces it before parsing anything else, which is what buys early refusal of a
future-version guest.

| key | value | semantics |
| --- | --- | --- |
| 1 | `abi_version` | must match; first entry |
| 2 | `layout_hash` | compared to the session's; a mismatch refuses with the field and both values |
| 3 | `arena_size` | live arena bytes; nonzero, 16-aligned, ≥ layout floor |
| 4 | `max_arena_size` | reserved ceiling; also the guest's `--memoryBase` |
| 5 | `callbacks_ptr` | guest-heap address of the `Callbacks` record; ≥ `max_arena_size`, 4-aligned |
| 6 | `callbacks_len` | 64 (the manifest's `Callbacks` size), or **0** for "no record": then `callbacks_ptr` must be 0 too |
| `0x0100 + class` | `ring_capacity_<class>` | optional, one per class 0-9; absent ⇒ the class default |

**An absent callbacks record is legal.** `callbacks_len = 0` with
`callbacks_ptr = 0` means the guest registers nothing at all — the limit case of
§8's "every slot is optional", and the shape a guest that will poll
(`session_drain`) or read the rings itself actually wants. A zero length with a
non-zero pointer is refused, as is a non-zero length with a null pointer: a
half-stated record is the writer and the reader disagreeing, and this boundary
refuses a disagreement rather than guessing which half was meant.

The whole `0x0100..=0x01FF` range is the ring namespace, so `ring_capacity_12`
is a *named* refusal rather than an ignored key. An unknown key number outside
that range is ignored (the argmap precedent), and a key that appears twice
takes its last value.

**What a hash mismatch can and cannot say.** The diagnostic names the field
(`layout_hash`) and both values. It does **not** name the offending type: one
shape hash cannot say which entry differs, and the config carries no manifest to
diff against. Future work, not chunk 1: a `manifest` blob key — the guest's own
`{typeId, size, align}` table, which its SDK computes from `offsetof` anyway —
would let the session walk the two catalogues and name the first type that
differs. Until then the honest message is the one above.

**The decoder in `tension-core/src/session/config.rs` is authoritative for this
format.** This table describes it; the module's tests pin it; and until the
guest SDK's encoder exists (A3) there is no other writer to disagree with. Once
it does, the repo's usual asymmetry applies — the SDK is the writer and the
decoder is its strict reader, so the encoder is what changes if the two ever
differ.

### 6.2 Check order

Fixed, so diagnostics are deterministic: `abi_version` → `layout_hash` →
C1 → memory import match (C2/C3) → required regions (§7.2) → layout fit (C4) →
ring capacities → callbacks resolution. The first failure is the one reported;
later checks are not attempted. A second `session_open` with identical
parameters returns 0; with different parameters it returns `-EBUSY`.

C4's guarantee — the live arena holds everything the session and the loaded
capabilities need — arrives in two parts, and the *specific* part is asked
first. The required-region check can name the capability and the region —
*the capability `echo` needs the JOB region, which ends at 57344 (0xE000), and
arena_size is 4096 (0x1000)* — where the frozen-floor check can only name two
numbers. Both refuse with `-EINVAL`, and every one of the frozen twelve ends at
or below `LAYOUT_FLOOR`, so the reordering accepts nothing the floor would have
refused — it only changes which message is printed, and only in the case where
a loaded capability can say something better.

### 6.3 The state machine

```
0 UNINIT   memory exists; structural arena written; nothing validated
1 READY    session_open succeeded
2 FAULTED  terminal until closed: callback trap, adapter fault, or arena tamper
3 CLOSED   session_close completed
4..7       reserved
```

Transitions: `UNINIT → READY` (valid open); `UNINIT → CLOSED` and
`READY → CLOSED` and `FAULTED → CLOSED` (`session_close`, idempotent, returns
0 from every state); `READY → FAULTED` (session-detected only); `CLOSED → READY`
(a fresh open; the arena is rewritten); **`FAULTED → READY` is refused with
`-EBUSY`** — close first.

**Instantiation order, and `__start`.** The host does five things, in this
order: `linker.instantiate`; `verify_post_instantiate` (the control block's
triple, the region band's zeros, the gap's lattice); call the module's exported
`__start` **if it has one**; open the session if the run asked the host to
(`--session-open`, an A1 test convenience); call `_start_game` (or `_start`).
`__start` is the toolchain's runtime initializer and the position is the point:
it runs guest code, so it must run *after* the arena has been verified and
*before* anything the game wrote. It is part of the host–guest contract, not an
AssemblyScript detail: a hand-written `.wat` that exports no `__start` is
unaffected, and a toolchain that would otherwise emit a `start` section should
offer the same door rather than a section the host refuses.

**Every verb except `session_open` and `session_close` returns `-EBADF` when
state ≠ READY.** A verb that detects a fault during its own entry returns
`-EIO` *and* moves the machine to `FAULTED`. The arena's `state` field is the
report; the authoritative machine is host-side, never in guest-writable memory.

## 7. Adapter protocol

### 7.1 The vtable

`init`, `link`, `publish`, `apply`, `shutdown`, `destroy`, with `abi_version`,
`name` and `flags`. `publish` and `apply` may be NULL ("nothing to do"); a
`publish` that is NULL means the adapter has no host → guest regions of its
own. `init` may block (device/window creation) but must not enter a loop.
`link` is pure registration with no I/O. `shutdown` is idempotent and joins any
background thread **on that thread's own terms** — the render thread tears
down its OGRE objects before exiting, because OGRE's render systems are not
thread-safe. `destroy` frees the adapter's storage.

### 7.2 What an adapter registers and calls

At `link`: `register_source`, `register_import` (module, name, return type,
parameter types, arity, function pointer, context, verb id, flags), and its
**required region kinds**. `TENSION_IMPORT_DEFERRABLE` marks a verb that may be
called from inside a callback (the `queue_*` verbs); the session copies the
record and applies it later. `TENSION_IMPORT_REENTRANT_READONLY` marks an
exempt accessor — this bit is how the session learns which of a capability's
verbs may run inside a callback, which the earlier rounds required but never
specified. `region_lookup(kind, &offset, &size)` is called at `link` time, which
is safe **only because region offsets are compile-time constants** (§5.2): it
consults the session's authoritative host-side table, works before the arena
exists, and the adapter caches the offsets and uses them in `publish`.

`post_event` is the only core function an adapter may call from a non-guest
thread. It never touches guest memory, never blocks, and returns `-ENOSPC` when
a class queue is full so a producer that can throttle will.

**The publish budget, and what `-ENOSPC` means there.** A `publish` hook draws
on a per-adapter, per-epoch byte budget (1 MiB in chunk 1, enforced by the
session's `guest_write`). `-ENOSPC` from `guest_write` *during publish* means
"this epoch is over budget": the adapter should stop writing and let the next
epoch's publish finish the work, not retry in a loop. Hitting it leaves regions
partly written, which is the honest signal that the hook is doing more in one
epoch than the session will pay for — the budget is a backstop, not a target,
and the session logs every exceedance with the adapter's name.

If a `session_open` `arena_size` would leave a required region absent, the open
is refused with `-EINVAL` naming the region and the adapter. Without that check
a smaller arena could silently truncate a region whose offset an adapter had
already cached at link time.

**How a region is declared, and what the check refuses.** There is no separate
declaration call: *asking* `region_lookup` about a kind during `link` **is** the
declaration. The registry records every kind asked about, per adapter, and the
set travels with the loaded adapter; `session_open` checks each entry against
the arena the config declares, and refuses in two cases — a kind this layout
does not define (the adapter was told `-ENOENT` at link time and has no offset
to write to), and a region whose end lies past `arena_size`. The check runs
before C4 (§6.2) so a truncation that a loaded capability can explain is
described in the capability's terms. With no adapters loaded the set is empty
and the check is a no-op, which is the state every A1 test but the loading ones
runs in.

**The log channel's prefix names the module.** The `log` slot writes one stderr
line on `[tension:session]` because it is the *session* that implements the
slot — the prefix identifies the service, not the caller. An adapter's messages
are its own to identify, and the reference adapter does (`echo: init`, then
`echo: two imports registered`); a v2 additive field for a structured source id
is listed in §12's future work.

**The `JOB` region is what the guest reads.** The SDK's `jobState()`,
`jobResult()` and `jobError()` do not call `job_state` — they range-check and
read the 64-byte record straight out of the region, so an adapter's *publish*
mirror is the load-bearing path and the `job_state` verb is a convenience for a
guest that wants a copy at an address. The same asymmetry as everywhere else in
this design: events are advisory, the status table is the truth, and a dropped
`JOB_DONE` costs a guest nothing it cannot read from the record.

### 7.3 What an adapter must not do

Never call the guest — not from the render thread, not from any thread. Never
touch guest memory outside `publish`, `apply`, or an import call, and never hold
a memory view across anything. Never write a guest → host region, or a region it
did not declare. Never block in `publish`. Never interpret another capability's
records. Never register an import in the reserved `session` module. Never
require a symbol from the host executable — every service arrives through the
core API table, which is what makes `dlopen` safe with no `-rdynamic`. Never
assume it is the only event source.

## 8. Callbacks and the trap policy

`Callbacks` is 64 bytes: `abiVersion u16@0`, `slotCount u16@2` (2 in chunk 1;
a larger value is refused), `flags u32@4`, `onBatch u32@8`, `onEvent u32@12`,
reserved `u32[12]@16`. Both slots are optional (`0` = absent), hold indices into
the guest's exported function table, are resolved once at `session_open`, and
are refused eagerly with `-EINVAL` on a missing, out-of-range, null, or
mis-shaped entry. `onBatch(class, table_ptr, count) -> i32` and
`onEvent(class, ptr) -> i32`, both `i32` at the wasm boundary.

The record itself is optional too (§6.1): `callbacks_len = 0` with
`callbacks_ptr = 0` is a guest that registers nothing, and the session resolves
it to the same empty `ResolvedCallbacks` a zeroed record does — no table,
no exemption list, no delivery.

A negative return is advisory (logged, batch still consumed). A **trap**
disables that slot permanently for the session's lifetime, publishes `FAULTED`
with `faultCode = -EIO`, `faultState = FAULT_CALLBACK_TRAP`,
`lastError = <slot index>`, abandons the batch (remaining deliveries stay
queued), and makes the entry point that pumped return `-EIO` even if the verb
itself succeeded — the verb's own result is already published in the arena and
remains valid. Later epochs skip the disabled slot and deliver the others.

**Two cases that used to be conflated.** (a) The verb that *discovers* a
callback trap returns `-EIO`: the operation the guest was attempting hit a
trapping callback, and that is the errno for "the callback failed". (b) Every
*subsequent* verb returns `-EBADF`: the session is FAULTED, and FAULTED is not a
state any operation runs in (§6.3) — a guest that wants to use the session
again closes it and opens a new one. The "-EIO until `session_close`" sentence
below belongs to **fatal adapter faults only**, which are a different class:
there the session is still coherent and still has work to refuse. A callback
trap is a guest-side bug; a fatal fault is the adapter's.

**A trap does not clear the pending queue.** R7 (§3.5): deferred submissions
were copied before the callback ran, so they are the session's, not the
callback's, and they are applied at the guest's next epoch — after the
close/re-open cycle (b) requires, since FAULTED refuses the wait that would
otherwise do it immediately.

A *fatal* adapter fault (device lost, OOM, render-thread death) is not a
callback trap: the session publishes `FAULTED` with the reason, sweeps every
in-flight job to `FAILED` with `-EIO` in the same publish phase, delivers the
fault and job callbacks once, and thereafter refuses non-exempt verbs with
`-EIO` until `session_close`.

### 8.1 Render thread obligations

The session calls an adapter's `init`, `link`, `publish`, `apply`, `shutdown`
and `destroy` on the interpreter thread, but a capability's render thread is
its own: nothing in the session watches it, and nothing outside it can save it.
Two rules follow, and the first is a process-lifetime rule rather than a style
note.

**Catch, always.** Every startup checkpoint and every frame runs inside a
`catch` for `Ogre::Exception`, for every other C++ exception, and for `...`. An
exception that escapes the thread is not an error the adapter can report: it
calls `std::terminate`, and the process dies. Measured, not theorised: a probe
running `RenderSystem_GL3Plus` with `DISPLAY` unset hit
`RenderingAPIException: Couldn't open X display` from
`GLXGLSupport::getGLDisplay` and exited 134, because nothing caught it.

**Report, never crash.** A caught failure becomes the adapter's normal failure
surface: a `DEVICE_LOST` event with the stage code in `a` and the errno in `b`,
the same errno and message in the renderer's `RESOURCE` record, one
`[tension:ogre]` line, and a stopped frame loop. The guest learns which stage
failed and why, the interpreter keeps running, and a capability that cannot
render is a capability whose start failed — not a process that vanished.

**The loader's boundary is bytes versus OGRE.** Resource loading splits at the
one place that needs no thread-safety argument: a worker thread resolves the
path, reads the bytes, checks the file's magic number and reports an errno —
and calls *no OGRE function at all*. Every OGRE call (parse, convert, create)
happens on the render thread, in `drain_completions`, which runs once per frame.
This removes the "is OGRE thread-safe" question by never asking it: the plan
does not depend on an answer nobody can verify from headers, and the worker is
testable with no renderer at all. The alternative OGRE offers — `MeshManager`'s
`prepare()`/`load()` split, where the IO is documented to happen in advance — is
recorded as the fallback if parsing from a memory stream ever proves awkward.

## 9. The seven verbs

```
session_open(cfg_ptr, cfg_len)  -> i32
session_close()                 -> i32
session_wait(timeout_ms)        -> i32   > 0 deliveries, 0 clean timeout
session_drain(class)            -> i32
session_subscribe(sub_ptr)      -> i32
session_unsubscribe(class)      -> i32
session_pending()               -> i32   deferred submissions outstanding
```

`session_subscribe` takes a transient 16-byte `Subscription` record
(`class u32@0`, `mode u32@4`, `flags u32@8`, `reserved u32@12`) that may live
anywhere in guest memory, not only in the arena. A `Subscription` carries no
capacity: ring geometry is fixed at `session_open`, and subscription changes
delivery mode only. `session_wait` uses a larger drain cap than a verb's
pre-pump; a cap that is hit leaves the rest published in the rings for the next
epoch.

## 10. Build pipeline

One source of truth per project (`session.json`), from which a small
repo-provided generator emits both the `asc` flags and a generated
`build/session.config.ts` holding the arena constants the guest sends in the
TLV. Values cannot drift because they are derived, and the generator fails the
build (non-zero, nothing emitted, the offending number named) when a request
violates the relation.

Flag rules: `--importMemory`, `--memoryBase = max_arena_size`, page counts for
`--initialMemory` / `--maximumMemory`, `--exportTable`, `--runtime stub`, and
**`--exportStart __start`** — the last one learned by building. AssemblyScript
0.28 emits a `start` *section* by default, and the load-time check refuses one —
**in a session guest, which is what this pipeline builds**: a start section runs
guest code at instantiation, before the session has verified the arena, and the
session is the only thing there is to run ahead of. `--exportStart` makes the
runtime's initializer an export instead, and the host calls it at the safe
point: see §6.3, where that is now part of the instantiation contract rather
than an AssemblyScript workaround.

**The scope of that check is its rationale.** A guest that imports nothing from
`session` has no arena and no verification, so a start section is its own
business — and that is exactly what the pre-session examples are (io, audio, ai,
res, solver): they predate the session and build with plain `asc`, which emits a
start section by default. Refusing them was the check reaching past its own
reason, and the fix is one condition: `imports_session && declares_start_section`.
The same scoping applies one line earlier in the load path, for the same reason:
the session's constructor requires a memory *import* because a session owns the
arena, so the session is created **only for a guest that imports it** — a
non-session guest defines its own memory and reaches the host ABI through
`get_export("memory")` like every other guest, and the three verbs refuse
cleanly (`no session is installed`) if such a guest calls one.
**`--noExportMemory` is forbidden** (F2). `--lowMemoryLimit` is forbidden (it
errors above its limit, and a multi-MiB base always would).
**`--zeroFilledMemory` stays unset in chunk 1.** Its safety condition is the
invariant "the session never writes above `memoryBase`", which `zero_band` and
`verify_post_instantiate` enforce — the band the session zeroes is
`[0, min(declared pages, memory_base))`, and the lattice covers the gap above
it — but no test states the invariant in those words, and a flag whose
precondition is unnamed is a flag waiting to be wrong. When
`test_session_writes_nothing_above_memory_base` exists (§12), opting in becomes
a one-word change to the generated asconfig.

## 11. Error surface: a wrong `memoryBase`

Three cases, and only one of them is inherently silent.

- **The generated constants and the flags disagree** (a hand edit). Impossible
  when both are generated; caught anyway by the guest's own startup assertion
  against `SessionInfo.maxArenaSize`.
- **The guest's build used a smaller `memoryBase` than the session's
  `max_arena_size`.** Caught at `session_open` by C2, because the module's
  declared minimum pages encode the build's `memoryBase`. `-EINVAL` with a
  named diagnostic.
- **A hand-built module that overlaps anyway.** This is the silent case, and it
  gets the canaries (§5.4) plus the sequencing below.

Load time, before instantiation, three checks that read only the module: a
module importing `session::*` without a memory import is refused; a module
importing a memory without exporting one named `memory` is refused (F2); a
module with a wasm `start` section **and a session import** is refused, because
a start section runs guest code during instantiation, before the session can
validate the arena — a guest with no session import has no arena to validate
and keeps its start section, which is the pre-session examples' shape and the
load-time check's own reason applied to itself (the scope landed in the round
after chunk 8's; before it, the check refused every example in `examples/` that
predates the session).
All three are `anyhow::bail!`, the precedent being `main.rs`'s
`"game.wasm did not export \`_start_game\` or \`_start\`"`.

**These three are step 12's wiring and are not implemented yet.** The middle one
is the urgent one: a module that imports the arena memory without re-exporting it
named `memory` leaves every existing service's lookup —
`caller.get_export("memory").expect(...)` in `tension::io`, `tension::audio`,
`tension::ai` and `tension::solver` — panicking, so the run must be refused with a
`bail!` naming the fix (`do not build with --noExportMemory`) rather than dying
inside `print`. Until that wiring lands, the build pipeline's ban on
`--noExportMemory` (§4.3) is the only thing keeping the case out of a session
build.

Three more refusals belong to the same moment but are the session's rather than
the loader's, and they come back as a named `SessionError`: a memory import
under a name the session does not define; a module declaring two memories; and
a *shared* memory import. **The shared-memory refusal is implemented but
untested** — constructing a valid shared-memory module needs the threads
feature enabled, and nothing in this chunk depends on the answer, because the
arena is not shared (the guest is single-stack and adapter threads never touch
guest memory). It exists to keep the boundary honest rather than to serve a
case, and it will be pinned when threads become relevant.

The canary sequencing, which corrects an earlier round's claim: the moment
"after AS's `_start` and before guest code" does not exist, because
`session_open` is called *from* `_start_game`. The real sequence is —

1. **Before instantiation.** Create the memory from the module's declared
   import type, define it under both names, then **zero the entire band the
   module claims** (`[0, declared_min_pages × 64 KiB)`), and only then write
   the header page's structures — control block, `SessionInfo` skeleton, region
   table, manifest — and lay the canary lattice over the reserved gap. The
   order is load-bearing: zeroing after the writes would erase them, and the
   zero baseline is what makes step 2's negative check meaningful.
2. **After `linker.instantiate`, before `_start_game`.** Three checks, cheapest
   first: the control-block triple (magic, layout hash, region count); that the
   region band `[header_page, layout_end)` is **still all zero** — a *complete*
   test for a data segment landing inside the live arena, because nothing else
   writes there before the guest runs; and the gap's lattice, which names the
   block that was overwritten if a rogue segment landed in the gap rather than
   in the band.
3. **`session_open` entry.** Re-verify the triple and resample the lattice;
   then write the real `SessionInfo` and the ring headers, bind callbacks, and
   set `READY`. (The gap holds a lattice from step 1 onward, so the gap's
   startup check is step 2's lattice verification rather than a zero sweep;
   §5.4 says which mechanism covers which case.)
4. **Every later verb and epoch entry.** Rotating lattice sample plus the
   control-block triple.

## 12. What chunk 1 does not deliver

No OGRE-Next code of any kind: no C++ wrapper, no shader compilation, no HLMS
integration, no render thread. No AssemblyScript beyond the SDK skeleton. No
dynamic region allocation. No `RING` delivery mode (reserved, stubbed). No
second wasm memory. No multi-guest support: the session, like the rest of
`tension-core`, assumes one guest per process. And no OGRE version pin — the
renderer and headless choice are config keys, and the pin is a build-time
concern that the wire format does not depend on.

### Future work

Recorded here so the seams are named rather than rediscovered. None of these is
chunk 1 work, and each is additive:

- **The fixtures share one resource tree, and that is the convention.**
  `tension-ogre/tests/resources/` holds every asset the fixtures load
  (`meshes/`, `textures/`, and the skeletons **in `meshes/`, beside the meshes
  that link them** — the loader derives a rig's skeleton from the mesh's own
  path, so a `skeletons/` directory is a directory nothing looks in);
  `tests/pack.sh` packs it into `build/fixtures.tns` once, and every case in
  `run.sh` hands the path to its guest as `--tns=`. The examples stay
  self-contained instead — each carries its own `resources/` and `pack.sh` —
  because a reader studies an example as a whole, while the fixtures are tests
  that happen to load the same four meshes. The framework's own `guest-ogre.ts`
  is the exception that proves the boundary: it runs against the **stub**
  adapter, which completes jobs synthetically and has never read a disk, so
  there is no asset to migrate and its bare `meshes/hero.glb` names nothing.
- **Deflate costs 6× on a mounted read, and it does not matter yet.** The 11a
  probe measured 946.6 µs through a volume against 158.2 µs from disk for the
  same 94,025-byte mesh (the volume arm pays decompression; the packer has no
  "stored" flag). Per mesh, once, at load time, next to the disk arm's syscalls
  it is nothing — but a round that wants the raw number wants a packer switch,
  not a loader change.
- **`SUBMISSION_REJECTED` is class 3, not the last class.** The round that
  introduced deferred submission numbered it last (`9`); the urgent-first
  ordering that same round adopted puts it at `3` (§3.2), and the frozen
  catalogue — not the prose in that round's brief — is what the code uses.
  Recorded here because the two disagree and the code is right.
- **`class_info`'s flags byte gets named constants at v2.** Today it carries one
  bit, `CLASS_FLAG_SUBSCRIBED`, defined host-side in `arena.rs` because the
  frozen header documents the parameter ("so a producer can skip generating
  events nobody subscribed to") but names no constant for it. A v2 header would
  name that bit and the ones that follow; a producer that reads the byte today
  sees one documented bit and must ignore the rest.
- **R7's fault recovery needs an SDK-side helper, and now has one.** The raw
  contract is correct but user-hostile: after a callback trap the session is
  FAULTED, every verb refuses with `-EBADF`, and the guest must close and open
  again before anything works — including the epoch that would apply the
  submissions it deferred (R7). Nothing is lost by doing that, but a game author
  should not have to know it. `tension-framework/assembly/runtime/index.ts`
  exports `Session.recover(cfg, callbacks)`, which is close-then-open with the
  config the caller already has, plus `isFaulted()`; the docstring there states
  what survives (the pending queue, the disabled slot). A2's `--session-open`
  note below is the same shape of problem, solved the same way.
- **`test_session_writes_nothing_above_memory_base`, and then
  `--zeroFilledMemory`.** The invariant is enforced from both ends today —
  `Session::prepare_arena` zeroes only up to `memory_base`, and
  `verify_post_instantiate` requires the band below it to still be zero and the
  gap's lattice to be intact — but a *test* that says "the session writes
  nothing above `memoryBase`" is what would let a build opt into
  `--zeroFilledMemory` (a faster startup for multi-MiB memories) without
  trusting a comment. Chunk 2 work, not chunk 1.
- **The framework's layout-hash cross-check reads `layout.ts`.** Not a separate
  stamp file: the file the Rust test parses is the file `asc` compiles, so the
  check cannot pass while the guest is built against something else, and there
  is no generated artifact to go stale. Its second leg compares the same value
  against `session.json`, so all three copies — guest, manifest, host — are
  tied together in one test that runs in `cargo test`.
- **`--session-open` goes away when the SDK lands.** It is A1's convenience and
  nothing else: A1 has no guest SDK, so the smoke fixture cannot send the config
  TLV a real guest sends, and the host performs the open instead. A real guest
  calls `session_open` itself — that is the design — so the flag is removed as
  soon as a guest can, and the fixture goes back to opening its own session.

- **A log source identifier (v2, additive).** The `log` slot carries a level, a
  pointer and a length (§7.2); which capability is speaking has to be spelled
  into the message. An added field (`source_id`, the id `register_source`
  already returns) would let an operator filter without parsing text.
- **An `adapter_ctx` slot in the vtable — required, not a nicety, for
  concurrent adapters in one process.** The frozen header has no context
  accessor, so the core calls every slot with `ctx == NULL` and an adapter keeps
  its state in file-scope statics. `dlopen` on the same path twice hands back the
  same image, so two instances of one adapter share those statics — **measured**,
  not theorised: A2c's epoch tests loaded the reference adapter from two
  harnesses at once, and one test's `g_core` was overwritten by the other's,
  which segfaulted on a caller belonging to a different store. The tests work
  around it by loading a private copy of the `.so` per harness; the fix is a
  `void *(*context)(void)` slot, or a per-instance handle threaded through
  `init`, and until it exists one process is one instance per adapter.
- **A `manifest` blob key in the config.** Today `layout_hash` can only say
  *that* the guest and the session disagree (§6.1). A guest-supplied
  `{typeId, size, align}` table would let the session name the first type that
  differs. It is also the mechanism a second protocol type catalogue would need
  when capability records join the manifest (§5.1).
- **An Hlms template directory key.** The templates' location is derived from
  OGRE's prefix today (`Media/Hlms/...`); an install with a non-standard media
  path should be targetable by config or environment rather than by a rebuild.
- **Scene hierarchy.** Landed in chunk 5a as `parentId` in the wire, with the
  composition delegated to OGRE's scene graph (see §5.1). The cost this entry
  used to predict — "cached world transforms invalidated when a parent's
  changes" — was over-estimated: that cache is the renderer's, and what the
  adapter actually pays is validation, the removal rules, and on-demand parent
  creation. Skeleton hierarchy landed in 5b as the bone table, and it is OGRE's
  own `SkeletonInstance` rather than a second scene graph (see §5.1). The same
  entry's estimate held up there too: what the adapter pays is one integer
  compare per frame, a validation pass over the batch, and 2.2-2.9 µs when the
  rig actually moves.
- **Hand-written lists that can silently omit a member.** Chunk 5b's finding,
  and the reason this entry exists rather than a one-line fix. Every Hlms
  archive folder list is hand-written, and a hand-written list omits whatever
  nobody has needed yet — silently. `HlmsPbs`'s list stopped one folder short
  of `Hlms/Pbs/Any/Main`, where the vertex shader lives; a PBS datablock then
  created, bound, reported hlms `"pbs"`, and drew **nothing at all**, with no
  exception, no log line and no failed compile. The Unlit list happened to be
  complete, which is why the omission stayed hidden for two chunks.

  The rule for the next one: **read `getDefaultPaths()` (or the equivalent)
  from the pinned OGRE-Next source whenever a new Hlms is added, and prefer
  fetching the list programmatically over hard-coding it.** The pin is
  `75643c3997f5b6d2aa1d7bd8400b9be6736d9908`; a list copied from it is a
  snapshot, and the commit that moves the pin is the commit that re-checks
  every list taken from it. Resource locations follow the same rule against
  OGRE's own `resources2.cfg` — the adapter reads that file now instead of
  naming `<media>/models` and hoping it was the only entry that mattered.

  This is also what the render tripwire (`tests/guest-render-check.ts`) is
  for: one control mesh, one distinct colour per material kind, and a pixel
  assertion per kind. A material path that stops drawing is loud there, where
  in a skinned test it would only look like a rig that did not move.
- **More cameras, and split-screen.** 3b activates the first camera it is
  given and leaves the others created but unattached; viewports per camera are
  a compositor-workspace question for later.
- **An Hlms template directory config key.** The templates' location is derived
  from OGRE's prefix today; when the SDK key space opens past 7, it belongs in
  the config beside the media search paths.
- **A `resource_release` verb.** `job_release` frees a *job* slot; nothing yet
  frees a realised *resource*. A guest that cycles jobs can fill the RESOURCE
  table (1024 records) and start failing jobs with `-ENOSPC`, which is a
  ceiling, not a policy. The submission sub-chunk is where a guest will have
  resources worth keeping, so the release verb belongs with it.
- **A media search path config key.** The adapter's lookup paths come from the
  build (`TENSION_OGRE_MEDIA_DIR`, derived from OGRE's prefix) with an
  environment override, because the SDK's key space is fixed at 1–7. When that
  space opens past 7, a `media_paths` key is the natural home for it.
- **Dynamic region allocation.** Chunk 1's region table is fixed-layout (§5.2);
  a capability with its own regions needs either a schema bump or an allocator,
  and the required-regions check (§7.2) is the seam it would attach to.

- **The unused-import fixture — measured, answered.** Binaryen drops an
  `@external` import a module declares and never calls: seven declared, one
  called, one import in the compiled module (98 bytes). The SDK therefore needs
  no build-time import filter, and the adapter registers only the verbs it
  implements (see §5.1).
- **The render thread is exercised end to end.** Round 2b's guest-window
  fixture drives start → ready → post → pace → stop for the first time against
  the real NULL render system, and — manually — against GL3+. Before that round
  the path compiled but had never executed, which is the distinction this line
  exists to record.
- **`create_mesh` covers one topology and one index width.** Round 5.5 ships
  `TOPO_TRIANGLE_LIST` with 16-bit indices — which the 512 KiB
  `PROCEDURAL_CAPACITY` makes sufficient rather than merely convenient, since
  512 KiB of interleaved positions is ~43,000 vertices and never reaches the
  65,536th index. What a later round would add, in the order the demand is
  likely to arrive: more vertex elements (tangents, vertex colours, a second uv
  set) as more `VF_` bits; lines and points as more topologies; 32-bit indices
  if `PROCEDURAL_CAPACITY` ever grows past what a 16-bit index can address; and
  a **dynamic** vertex buffer for a mesh whose *positions* change per frame —
  which is a different mechanism from `MotionBatch`, because a motion entry
  moves an object and this would move its vertices.
- **Physics beyond chunk 6.** Angular dynamics with an inertia tensor is the
  next capability, and its cost is known before it is written: four more state
  slots per body (a quaternion) plus angular velocity puts the state at 14 per
  body — Verlet's halves must match, and 7 + 6 does not split — which caps N at
  **585** on the 64 KiB buffer convention, against 1365 for the linear model.
  After that, in the order the demand is likely to arrive: joints (hinges,
  sliders); continuous collision detection, which matters the day a body moves
  faster than its own radius per sub-step; non-sphere collider pairs (boxes,
  capsules) and with them a real narrow phase; a uniform grid or a BVH for
  detection beyond ~256 bodies (brute force is 1.17 ms per pass at N = 256 and
  18.3 ms at 1024, so the state cap is what binds chunk 6's sizes); and the
  solver-side constraint channel (`spook`), which stays deferred and is the one
  item here that is the solver's work rather than the guest's.

  **Sleeping left this list in chunk 7**, and what it bought is worth keeping in
  view: the pile's residual creep is gone, the example exits when the last body
  sleeps instead of at a frame count, and the acid test's terminal-state clauses
  are equalities (kinetic energy exactly 0, the state bit-for-bit unchanged over
  thirty frames) rather than thresholds. What is still absent is what sleeping
  usually comes with in a mature engine — island detection (a pile sleeping as
  one decision rather than N), a wake radius for bodies that move near a sleeper
  without touching it, and `setParams`-driven wake propagation to neighbours.
  Each is a §12-sized round of its own, and none of them is needed for the
  behaviour the acid test now asserts.
- **Angular dynamics, and what it leaves for later.** Chunk 8's model is
  diagonal-inertia, one-pass, spheres and boxes about their axes. In the order
  the demand is likely to arrive: **full inertia tensors** (a rotated box whose
  principal axes are not its body axes needs `I⁻¹` as a matrix, not three
  numbers) — and the layer applies its three diagonal numbers in **world axes**,
  which is exact for a sphere and a simplification for a box whose principal
  axes have swung away from them (chunk 8b ships it that way, with the
  simplification stated at the field); **capsules and other non-diagonal
  shapes**, which need the same thing plus a narrow phase that is not a corner
  list; **angular sleeping shipped in 8c1** — and in a different shape than this
  list sketched, which is worth keeping: the signal is angular *displacement*
  (the angle between two frames, averaged over the same window as the linear
  one), not `|v| + |ω|·r`, because mixing a linear speed with an angular one
  needs a length to make them comparable and a body has no single one — two
  signals, two thresholds, one window, and a body sleeps when both say still
  (§5.1). Chunk 8b had measured the failure it fixes: a free body spun at 1 rad/s
  turns 0.5 rad instead of 1.0 when the linear signal sleeps it at frame 30 and
  zeroes the spin with it. **Wake
  propagation** to neighbours, since today a sleeper wakes only on direct
  contact; **friction that does not creep** — the resting box's 0.044 m of
  drift over 600 frames is one-pass friction at four corners, and the honest
  fixes (an iterative friction pass, a contact manifold, or a velocity-level bias
  applied to the position rather than the velocity) are each their own round.
  **A note for whoever writes the next state model**: the family decides the
  layout. The symplectic Verlet reads the *state's* second half as the
  coordinates' time derivative and the *RHS's* second half as their acceleration;
  an RHS whose first half is a beautiful, correct derivative is simply ignored,
  with no error anywhere — the probe measured 1.5708 rad where 1.0 was asked for
  (§5.1). And quaternion state writes are as safe as linear ones: written back
  verbatim, the spin is bit-identical.
- **Rolling resistance is delivered** (chunk 9a-ii), with the honest record of
  how it got its coefficient. The chunk-9a plan's arithmetic window `[3.2, 4.5]`
  was **refuted by its own probe, empty by 1.5×**: the real requirements were
  `roller ≥ 90° ≤ 14.5`, `asleep by 120 ≥ 12`, `spinner ≥ 30° ≤ 7.8`. Three
  measured corrections moved it — the resolved-contact gate sees only 23 % of a
  resting body's sub-steps (the candidate gate sees 92–100 %); a rolling pair
  decays at `2/7` of `k`, not at `k`; and skipping the damping below the sleep
  threshold parks a body *on* the threshold instead of letting it sleep (§5.1).
  The default is **k = 13**, which is what the roller's own clauses require, and
  the spinner's turn floor moved from **30° to 25°** as the smallest of the three
  levers (the alternatives were its drop height, 0.55 → 1.05 m, which drags the
  fixture's displacement ceiling with it, and the fixture's horizon, 120 → 160
  frames, which alone was *still* not enough). **A second rate remains off the
  table**: the roller and the spinner wanting different `k` is not a missing
  parameter but a measured property of a pure-angular term — a spin decay dragging
  linear momentum it is forbidden to touch.
- **What lighting does not have yet, and what each would cost.** **Ambient
  light** is a scene-level base colour, not a light — it belongs in the scene
  configuration the adapter owns, not in `LightRecord`, and it is what an unlit
  hemisphere would need to stop being pure black. **Shadow mapping** is the
  largest item in this list and its cost is known: a shadow camera per light, a
  depth pass into a texture, `setCastShadows` on the light and the renderables,
  a light-space matrix through the Hlms's shadow-node machinery, and a probe of
  its own — which the plan for chunk 10 deliberately did not open. **Spot
  lights** are "in if the probe shows they cost nothing, otherwise here": the
  backend already has the `LT_SPOTLIGHT` case and the attenuation call, so the
  only open question is whether the two cone angles need a call the backend does
  not make. **Environment maps / IBL, area lights, and physical light units**
  (lumens, candela) stay out of scope by decision, not by omission: the
  intensity scalar is a power scale and the probe reports what it does.
- **The older note, kept for the boundary it still names.**
  Chunk 9a-i wrote the term's arithmetic, measured it, and refuted itself; §5.1
  carries the three measurements (an intermittent contact gate, a rolling pair
  that decays at 0.286·k, and a stop rule that parks a body on the sleep
  threshold). The clause requirements the probe measured, with the gate on a
  contact candidate and no parking: the roller's **≥ 90° turn needs k ≤ 14.5**,
  **asleep by frame 120 needs k ≥ 12**, and the spinner's **≥ 30° turn needs
  k ≤ 7.8**. Empty by 1.5×. In ascending order of what each costs to move:
  **the spinner's turn clause, 30° → 25°** (at k = 13 it turns 26.7°, so a 25°
  floor passes with margin and the roller's two clauses pass at 118 and 100°);
  **the spinner's drop, 0.55 → 1.05 m**, which is 0.95 m of fall and therefore
  needs the fixture's own 0.5 m displacement ceiling raised to match — a clause
  moving to accommodate a test is a bigger change than a threshold moving;
  **the fixture's 120-frame horizon, 120 → 160** (+33 %), which alone is not
  enough (at the k a 160-frame horizon allows the spinner turns 29.3°, and that
  is *still* short). The smallest honest change is the first: one clause
  threshold, −17 %, with the coefficient at **13** and every margin thin but
  positive. **A second rate is not on the table**: a knob without grounding is a
  knob that tunes to the test — and the reason the roller and the spinner want
  different k is not a missing parameter but a measured one, the coupling between
  a spin decay and the linear momentum it drags.
- **Rolling resistance's older note, kept for the boundary it names.** A sphere that
  reaches rolling has no slip velocity at its contact, so friction has nothing to
  act on and it rolls forever (measured: 0.128 m/s held for a hundred frames
  after a wall bounce); a sphere *spinning about the vertical axis* has no slip
  at a contact directly below its centre either, so a top on the floor turns at
  1.0000 rad/s after two seconds. The term that fixes both is §5.1's —
  contact-only, pure angular, `ω ← ω·max(0, 1 − k·h)` — and three clauses of the
  chunk-8 fixture pinch its coefficient into `k ∈ [3.2, 4.5]`: the roller's ≥ 90°
  turn above it, "asleep by frame 120" below it, and the spinner's ≥ 30° turn
  above it again. **The probe is what settles the default** (3.6 is the plan's
  number, not a measured one). If the window comes back empty, the order in which
  things move is: the spinner's **drop test** first (30° → 25° → 20°, since its
  0.55 m drop is already capped by the fixture's 0.5 m displacement ceiling), then
  its drop height (0.55 → 0.7 m, which needs that ceiling raised with it), then
  the fixture's **120-frame horizon** — a number in the round's own text, and the
  most expensive of the three to move. **A second rate is not on the table**: a
  knob without grounding is a knob that tunes to the test. What stays true
  regardless is the boundary the term does *not* address: **a wheel or capsule
  collider**, whose useful axis is arbitrary, needs the full inertia tensor and a
  body-frame transform rather than the diagonal applied in world axes — which is
  where the full-tensor item above lands too.
- **The solver interface has a gap worth closing.** `create` accepts an odd
  `dim` and the *step* is what refuses it (`-EINVAL`), because the workspace-size
  query deliberately does not check evenness — its comment says so, and the probe
  confirmed both halves of it (create(dim=7) returns a live solver; step returns
  -22). A guest therefore cannot learn about a dimension it cannot use until it
  tries to use it, which for a solver the guest *builds a world around* is the
  wrong order. The honest fix is a check at `create`, where the error can name
  the requirement.
- **Module state means one World at a time.** The derivative has no context
  argument, so gravity, the sleep mask and the state-layout mode travel through
  module globals: two `World`s alive at once share them, and the second one to
  be created wins. The existing layer has always had this for gravity; chunk 8b
  adds the layout mode to it. It is fine for the shape both chunks use — one
  world, stepped, drawn — and it is the thing to fix first if a guest ever wants
  two models side by side (a context pointer in the shim's callback, or a second
  callback entry point).
- **CI configuration.** The repo has no `.github/` today: every gate in §14 is
  a script a developer runs by hand. Wiring them into CI is future work, and
  the layers below are ordered so the cheapest ones run first.

## 13. Verified and unverified

The two probe-first questions were answered against `wasmtime = 24.0.13` and
the pinned AssemblyScript toolchain, as unit tests in
`tension-core/src/session/mod.rs` (a stub that A1 replaces; the two tests stay
as regression tests):

```
cargo test --manifest-path tension-core/Cargo.toml --no-default-features \
    --bin tension-core probes -- --nocapture
```

**F1 — one memory, two import names: confirmed.** A single `Memory` handle
defined on one linker as both `env::memory` and `session::memory` serves guests
importing either spelling, and each guest observes the other's writes through
it — the two names resolve to one object. The stronger form was confirmed too:
a single module importing *both* names parses and instantiates under the
default configuration, and a write through the implicit memory is visible
through the second one. **Multi-memory is enabled by default in
wasmtime 24.0.13**, so no configuration is needed; the
`Config::wasm_multi_memory(true)` variant is equivalent here. No workaround was
required, and §4.2's dual definition stands as the shipped mechanism.

**F3 — the declared import type: confirmed.** The accessor chain is
`Module::imports()`, yielding `ImportType`, with `.module()` / `.name()` for the
pair and `.ty()` returning `ExternType`; a memory import matches
`ExternType::Memory(MemoryType)`, whose `.minimum() -> u64` and
`.maximum() -> Option<u64>` give the declared page counts (`.is_shared()` gives
the sharing flag). A module declaring `(memory 4 256)` reads back as
`min=4, max=Some(256), shared=false`.

**The matching direction, confirmed both ways.** Against a declared
`(4, 256)`: provided `(4, 256)` matches; `(8, 128)` matches (more initial
memory, smaller maximum); `(2, 256)` is refused; `(4, 512)` is refused; and an
unbounded provider `(4, None)` is refused. That is exactly C3 (§4.1), and it
means the session's mirror-the-declared-type policy always satisfies it. All
three refusals carry wasmtime's single generic message,
``incompatible import type for `env::memory` `` — which is the reason the
session pre-checks and reports the offending page counts itself.

Still unverified, and honest about it:

- The canary lattice's coverage *between* checks (§5.4) is a matter of degree
  rather than a yes/no, and `--zeroFilledMemory`'s precondition (the session
  never writes above `memoryBase`) belongs in a test rather than a comment.
### The smoke fixture's boundary case

`tests/fixtures/session_guest.wat` declares `(memory 128 512)` — exactly the
default `max_arena_size`. Its `memoryBase` therefore lands on the memory's end,
and the module owns no byte of its own. That is deliberate: it is the boundary
case of §4.1's relation (declared size == ceiling) and the smallest memory the
design can be asked to work in, so a fixture that runs there has exercised the
tightest configuration a guest can have.

The cost is that the fixture's two scratch buffers (`0x9000`, `0x9010`) sit
inside the region band, because there is nowhere else for them. Nothing in
chunk 1 refuses that — region *direction* is a table entry today, not an
enforcement — but it is **not** a pattern to copy: a real guest declares
`memoryBase` plus a heap and keeps its own bytes above the boundary, which is
what the flag being a flag (rather than the run path) leaves room for.

- The `asc` half of §4.1. The memory flags and their descriptions were read
  from the pinned toolchain's own option table (`--importMemory` — *"Imports
  the memory from 'env.memory'."*, `--memoryBase`, `--initialMemory`,
  `--maximumMemory`, `--noExportMemory`, `--zeroFilledMemory`,
  `--lowMemoryLimit`), but the compiler's initial-memory computation was not
  read end to end, so "the module's declared minimum already encodes
  `memoryBase`" is a design commitment rather than a measured fact. The first
  build of a session guest measures it.

---

## 14. Testing strategy

Five layers, from the contract outward. Each exists because the one before it
cannot see what it sees, and each names its substrate: a test that needs a GPU
is a test that cannot run where the contract tests run.

**Structural tests — substrate: nothing.** Events, jobs, the session verbs, the
adapter ABI, the wire layout: assertions about the contract with no renderer
involved. These are `cargo test` today — the WAT guests, the echo and ogre-stub
adapters, the layout cross-check, the adapter surface test.

**Smoke render — substrate: `RenderSystem_NULL`.** The window opens, the frame
loop runs, `shutdown` joins cleanly. The probe measured that this plugin
creates a window and returns true from `renderOneFrame()` with no display at
all, so this layer runs where the structural tests run: the real render system,
minus the pixels.

**Visual property tests — substrate: `RenderSystem_GL3Plus` with a display.**
The vertex and pixel pipeline produces the right *kind* of output: a corner
pixel that is the clear colour, more than N non-background pixels, and a mean
colour that is the material's. Properties, never baseline images, because a
rasterizer's exact pixels are a property of the rasterizer. Budget 5–30 s per
test.

**This tier is live, and `tests/guest-triangle.ts` is its canonical example.**
It loads `Barrel.mesh` through the 3a job path, submits an Unlit material, a
camera and a renderable, and asserts the three properties above against
measured numbers rather than invented ones: corner 25/25/25 (the workspace's
clear colour), 72 non-background pixels (the barrel at the probe's scale and
field of view), mean 229/51/51 (the material's 0.9/0.2/0.2). Later visual
tests follow the same shape — measure first, then assert the measurement with
tolerance. The tier needs a display: Xvfb is not installed here and llvmpipe
(`LIBGL_ALWAYS_SOFTWARE=1`) runs the GL3+ render system on this Mesa, so the
case is opt-in behind `TENSION_OGRE_WINDOW_TEST=1` in both `run.sh` and
`cargo test`, and the headless gate runs the same fixture's five structural
clauses instead.

**Visual regression — exact pixels against a stored baseline.** The strongest
statement and the most brittle: it asserts *this* output rather than *this kind*
of output. It lands when rendering is stable enough that a moved baseline
means a bug, and it is skipped wherever the driver is not the one the baseline
was recorded on.

**AI vision — supplementary, non-gating.** A model looking at a frame can
answer "is there a lit sphere in this scene", which no property assertion
answers. It is not deterministic enough to gate CI: it fails loudly in a report
and never by blocking a merge. Lands when scenes have semantic content.

The **visual** tier runs under GL3+ with a real window, or with llvmpipe
against that display; `RenderSystem_NULL` validates the object graph and the
frame loop but can never produce the pixels a visual assertion needs.

**The acid test.** One AssemblyScript guest that exercises the whole stack in a
single session and asserts its own results, printing a pass/fail summary line —
`ACID 8/8 passed`. It grows with the chunks:

- *first triangle*: render one triangle and assert its centroid lands where the
  transform says it should;
- *multiple objects*: N objects at distinct transforms, with the camera
  asserting what the scene holds;
- *solver integration (chunk 4)*: a solver steps once per renderer frame and
  drives 64 bodies through **one** `submit_motion` call per frame. Structural:
  the mesh loads, material/camera/renderable submit, the solver is created
  (`rk45`, `dim = 2`), a batch of 64 is accepted in one call, the frame counter
  advances. Visual: a baseline centroid at frame F; after 30 renderer frames the
  non-background pixel count is within ±30% of the baseline; the centroid moved
  **+X** by at least 18 px; the centroid delta equals the solver's own Δx over
  the measured units-per-pixel within **±4 px**; frame rate ≥ 30 fps at N = 64.
  Two choices make that deterministic rather than flaky: **constant velocity**,
  because the screenshot's request→download latency is a constant offset that
  cancels in a delta — an oscillator, the natural demo, would bias it — and
  **one solver step per renderer frame**, because the comparison is pixels
  against the solver's own state and never against a clock. The pixels-per-unit
  the tolerance rests on is measured, not derived: `probe_motion --calibrate`
  puts the barrel at x = 0, +0.25, +0.5 and reads the centroid back — **72.09
  px/unit measured against 72.4 analytic, 0.4% off**, i.e. 0.01387 units/px at
  the fixture's camera. The fixture's floor is the prediction minus the band, so
  the coarse clause and the tight one cannot disagree.

  **The frame-rate clause is a tripwire, not a proof.** At N = 1024 the probe
  measured a 12 µs transform pass and a `renderOneFrame()` that was not slower
  in the moving phase than in a static one, so "≥ 30 fps at N = 64" passes
  without exercising anything — its job is to catch a regression that makes the
  path an order of magnitude worse, not to establish a budget. What the
  throughput case is *for* is the report it prints beside the clause: entries
  per frame, batches, frames advanced, the wait iterations they took, the
  estimated frame rate, and the pixel delta with its prediction. A drift that a
  single boolean cannot see shows up in those numbers in the CI log. Measured
  this round at N = 64: 64 entries/frame, 30 batches, 30 frames over 31 waits,
  ~60.5 fps estimated, delta 18.04 px against 18.02 predicted.
- *scene hierarchy (chunk 5a)*: a parent node and a child node at local
  (1, 0, 0), a drawable hanging from the child, and the parent rotated 180
  degrees about Y. The drawable's own record is never touched after it is
  submitted, so the assertion is that the blob crosses from the right half of
  the frame to the left — 0 px left / 70 right before, 70 left / 0 right after,
  measured. That is the composition claim: the adapter composes nothing, OGRE's
  scene graph does;
- *skinned mesh (chunk 5b)*: a `Stickman.mesh` under a PBS datablock
  (kind `MAT_HLMS_PBS`, diffuse `(0,0,0)`, specular `(0,0,0)`, emissive
  `(0.9,0.2,0.2)`, roughness 1.0, metalness 0.0), scaled 0.6 so the silhouette
  is ~1574 px in a 320x240 frame. Baseline at frame F; then one bone — `Spine`,
  index 6, the clearest of the ten the probe swept — rotates 90° about X over 60
  renderer frames, one `BoneBatch` per frame. Assert: the pixel-flip fraction
  against the baseline is at least 0.005 (the measured clean-pose value is
  0.0197, so the floor is a quarter of it and still 25x the noise floor of a
  still frame), the non-background count stays within ±30% of the baseline
  (measured 1504 -> 1376, -8.5%), and no motion was submitted at all — the
  change is the rig, not the object. The material and the two setup requirements
  this depends on are §5.1's; without them the mesh renders 0 pixels and the
  test cannot tell an unbound datablock from a rig that does not move;
- *rigid bodies (chunk 6)*: `M` spheres dropped into a box for 60 rendered
  frames — 1.0 s of simulated time at dt = 1/60 with K = 4 sub-steps per frame,
  e = 0.3, μ = 0.4, β = 0.2, the parameters the probe's numbers chose.
  **Structural** (`renderer=null`, M = 16): every step returns 0 and the state
  stays finite — no NaN, ever, because a blown-up integrator is a state no
  later clause can be trusted to read; at frame 60 every |v| < 0.1 m/s
  (measured 0.057 at K = 4; the pile creeps, and no configuration the probe ran
  reached the ideal 0.05, so 0.1 is the honest threshold rather than a round
  number), every body's centre at y ≥ r − 0.005 m (measured deepest penetration
  4.0 mm at K = 4; 13 mm at K = 2 and 50 mm at K = 1), every pair's centre
  distance ≥ r_i + r_j − 0.010 m, and total kinetic energy < 0.02 (measured
  0.0076 for 16 bodies). **Visual** (GL3+, M = 16): the settled pile's
  non-background pixel count within ±30% of the projected area the state and
  the pinned camera predict; **no non-background pixel below the floor's screen
  row** the box's geometry puts on screen; and a pixel-flip fraction above a
  floor while the bodies are moving, falling to ≈ 0 once they are at rest —
  settled, not merely still. **The bounce-fidelity experiment** (one body,
  e = 1.0, 60 frames, a `state` + `set_state` between every step): its apex
  heights are identical to the no-write run within 0.1 % — the clause that says
  the impulse channel does not perturb the integrator, measured at 0.0 % in
  chunk 6a's P1b and pinned here so a later change cannot take it away. The
  physics is entirely guest-side (§5.1): this clause is about the model, not
  about the adapter;
- *deactivation (chunk 7)*: the same pile, run to 240 frames — four times the
  horizon above, because sleeping needs a window and then some. Assert: every
  body is asleep (`asleepCount() == M`); the kinetic energy is **exactly `0.0`**,
  not below a threshold, because every velocity was zeroed and the derivative
  keeps them zero; and the state vector is **bit-for-bit** the one from thirty
  frames earlier — all 96 components for M = 16, which is the clause that tells
  "asleep" from "creeping slowly" and the one chunk 6, with its measured 0.057
  m/s creep, could not make. The visual tier's late-frame flip fraction becomes
  exactly `0.0` rather than ≈ 0, and the example exits when the last body sleeps
  rather than at a frame count. The measurements behind the policy — the 0.057
  m/s creep, the ~0.14 m/s bias in a resting body's velocity, the counters that
  reset at 15-23 and then at 27 — are §5.1's, and each of them was a failing
  test before it was a paragraph;
- *tumbling rigid bodies (chunk 8)*: `M` bodies — spheres and boxes — dropped
  into a box under the angular model (`WorldConfig.angular`, 14 slots per body,
  120 frames at K = 4), asserted at three levels. **Structural**: every body is
  asleep at frame 120 (the same policy as chunk 7, and the clause that ends the
  measured creep rather than waiting it out); every orientation is finite and
  normalized, `|q|` within **1e-6** of 1; the total angular momentum magnitude is
  below **1e-3 kg·m²/s**, the tolerance the probe's resting-box drift sets. **The
  clause a linear-only model fails**: one sphere given an initial horizontal
  velocity **rolls** — measured, over 60 frames, `v/v₀ = 0.7161` against the
  sliding-sphere closed form's 5/7 = 0.7143 (0.25 % high), `ω·r/v = 0.9975` at
  rest, rolling (within 5 %) from frame **5**, and **5.72 rad (328°)** of
  accumulated rotation where the linear control accumulates **0.0 rad** and
  slides to a stop at `v/v₀ = 0.051`. **Visual**: the pile is drawn where the
  state says (non-background pixel count within ±30 % of the projected area),
  nothing below the floor's screen row, and the flip fraction is clearly non-zero
  while the bodies roll and exactly `0.0` once they are asleep. **The two
  permanent experiments**: chunk 6's linear apex (0.0 % delta) and chunk 8's
  quaternion state-write — untouched 1.0000101 rad, written back **bit-identical
  (0.0 %)**, canonicalized (renormalize + `q' = ½ω⊗q`) **0.00014 %** different,
  against the 0.1 % budget, so the angular model needs no second integrator. The
  naive layout is pinned as the counter-example: 1.5708 rad and `|q| = 1.41421`
  for a body that should read 1.0 rad and 1.00000 (§5.1). The physics is
  guest-side, as in chunks 6 and 7: no verb, no wire, no session change;
- *tumbling rigid bodies (chunk 8)*: sixteen bodies under the angular model —
  fourteen in a pile, one given a horizontal 1 m/s at floor level, one dropped
  with 1 rad/s about y — for 120 rendered frames at K = 4. **Structural**: the
  pile is asleep at frame 120 (14 of 14; the other two are clause 7's); every
  orientation is a unit quaternion within **1e-6**; the settled pile's total
  angular momentum is **0.0** against a 1e-3 ceiling; **the clause a linear-only
  model fails** — the roller turns **456°** over the run, and at the frame its
  sliding stops (frame 7) `v/v₀ = 0.7093` against the closed form's 5/7 = 0.7143
  (**0.7 %** inside the 2 % band) with `|ω·r + v| = 0.0085` (**1.2 %** of v,
  inside the 5 % band, against the linear model's 0.0 rad of turn and a slide to
  a halt); the spinner turns **114.6°** (the clause asks 30°) while moving
  **0.253 m** (the ceiling is 0.5 m) — the measurement chunk 8c1's sleep signal
  exists for, since before it the spinner slept at frame 30 with half its turn
  left. **Clause 7 is the model's boundary asserted rather than assumed**: the
  roller is still rolling (`|ω·r + v| = 0.0016` at frame 120) and the spinner is
  still at 1.0000 rad/s, because neither has slip left for friction — a rolling
  sphere and a vertical-axis top are the two things this model cannot stop, and
  a model that gains rolling resistance must fail this clause and say so.
  **Visual** (GL3+): the bodies are drawn within the projected band (113 px
  against a 345 px ceiling), **no pixel below the floor's row** (142 ≤ 143 —
  this is what caught the cube mesh's corners dipping below the sphere collider,
  which is why the fixture draws `Smiley.mesh` and the example, which draws
  cubes, documents the mismatch instead), and the flip fraction is 0.24 while the
  bodies move against 0.0 once the pile has slept. The physics is guest-side: no
  verb, no wire, no session change;
- *rolling resistance (chunk 9a-i)*: **not added, and the reason is a measurement.**
  The probe that was meant to ground this chunk's clause found the window empty —
  the roller's ≥ 90° clause needs k ≤ 14.5, "asleep by frame 120" needs k ≥ 12,
  and the spinner's ≥ 30° clause needs k ≤ 7.8, so no coefficient satisfies all
  three (§5.1 for the three measurements that moved the estimate, §12 for what
  would have to move: the smallest is the spinner's turn clause, 30° → 25°, with
  k = 13). Until that moves, chunk 8c2's clause 7 stands exactly as written: the
  roller is still rolling and the spinner is still spinning, and the tripwire is
  still a tripwire. Flipping it is 9a-ii's job and it needs a decision first;
  writing the clause before the coefficient exists would be the test deciding the
  model.
- *rolling resistance (chunk 9a-ii)*: the chunk-8 clause flips to the strong
  form, with `rollResistance = 13` and the spinner's floor at 25°. **Structural**
  (M = 16, 120 frames, K = 4): **all sixteen bodies asleep at frame 120 with
  `kineticEnergy()` exactly 0.0** — the pile, the roller and the spinner, where
  chunk 8c2 could only assert the pile; every orientation a unit quaternion
  (|q| error **0.0** against 1e-6); total angular momentum **0.0** against a 1e-3
  ceiling; the roller turns **102.9°** (the clause asks 90°) and reaches rolling
  at its slip-stop to within **0.0477 m/s** of a 0.05 bound; the spinner turns
  **39.0°** (the floor is 25°, down from 30° as the smallest of the three levers
  9a-i measured) while moving **0.253 m**; **the resistance is contact-only** —
  the spinner's ω stays within **2.4e-10** of 1.0 rad/s over the twelve frames
  before its first contact; and **the roller stops by its own decay** — asleep at
  x = 3.479, **0.42 m short of the wall**. **Visual** (GL3+): the bodies are
  drawn within the band (110 px against a 345 px ceiling), nothing below the
  floor's row (142 ≤ 143), and the flip fraction — 0.221 while they move, and
  **exactly 0.0** between two late frames, chunk 6's strong form again. Two
  clauses moved for reasons the probe measured rather than for convenience: the
  roller's **v/v₀ = 5/7 is an undamped identity** (this world is damped, and the
  slip-stop speed is **0.2509 v₀**; the clause keeps the part that is still a
  claim about the friction model — the roller must be *travelling* when it stops
  slipping — and the 5/7 identity stays measured in the probe's k = 0 row), and
  the clause's rolling bound is the detector's own 5 %-of-v₀ rather than a
  relative one that a damped roller cannot meet. One fixture bug surfaced on the
  way: its loop advanced two frames per `step` call, so the sleep policy — which
  ticks once per call — ran a 60-frame window instead of 30, and the roller
  missed the 120-frame clause by five frames. The fixture now steps once per
  frame, as the policy documents.
- *lighting (chunk 10)*: a directional light through the guest's `submitLight`,
  shading a PBS surface, with the material records the wire has always been
  able to carry (`diffuse`, `specular`, `roughness 0.5`, `metalness 0`,
  `emissive 0`) and no new material kind. **Structural** (`renderer=null`): the
  meshes load, the scene is accepted, the light is mirrored — `submitLight`
  returns 0, the region's slot holds kind `LIGHT_DIRECTIONAL`, the colour, the
  intensity and the direction — an upsert of the same id replaces the record,
  and thirty frames run with the light in the scene and **no refusal in the
  session log** (`apply_lights`'s failures are log lines; the adapter refusing
  nothing is what says the light was realised rather than dropped).
  **Visual** (GL3+, gated like every other pixel tier): one lit surface at
  `intensity 20` under one white directional light **perpendicular to the view
  axis** (the probe's +x geometry), split by the screen-space projection of the
  light direction. Measured: **lit half 255.0 over 914 px, dark half 0.0 over
  914 px, mid band 78.0**, brightest 255, whole surface mean 104.30 over 3440 px,
  and the ten-band profile `0 0 0.0 0.0 0.13 136.44 255.0 255.0 0 0` — the two
  intermediate bands are what say the transition is a falloff and not a step.
  The clause is therefore **`lit ≥ 4 × dark + 20`** (the round's ratio, plus a
  floor so a black frame cannot satisfy a pure ratio), the **mid band strictly
  between** the halves, **both halves carrying pixels**, and the profile's
  monotone non-decreasing shape. Removing the light leaves the surface at mean
  **0.0** and re-submitting it returns it to **104.30** — the light is what
  does it. The same frame's **emissive-only** PBS surface and its **Unlit**
  surface are **byte-identical with and without the light** (mean 144.0 over
  3746 px each — the probe's own 144.00, to the digit). The **skinned** path
  shades: the Stickman under a lit PBS datablock measures **lit 111.19 over
  698 px against dark 36.99 over 701 px, ratio 3.01**.
  Two things the round wrote differently, both measured first. The light
  direction is the probe's perpendicular one rather than the round's
  `(-1,-1,-1)`: at 54.7° off the view axis the two halves measure 247.08 and
  133.32 (ratio 1.85), because a surface that faces the light also faces a
  camera standing on the light's side — a gradient, not a hemisphere. And the
  lit half **saturates** at 0.9 diffuse × power 20 (the probe's 0.8 read
  217.58, not 255), so the ratio clause carries a floor and the profile carries
  the falloff claim: a saturated lit half would hide a hard edge. The intensity
  is 20 and not 1 — at 1 the probe measured a lit half of 19.7 and a brightest
  pixel of 26, which is a surface that is lit and looks black.
- *full stack*: a small controllable game with input, a light and a shadow.

The cumulative acid test is the milestone gate at each chunk end: a chunk is
done when the guest can say so itself.

# Appendix A — tension_adapter.h specification

The content specification for `tension-core/include/tension_adapter.h`. Prose
per section; whoever writes the header has every field, constant and rule here.

## A.0 File form

Guard `TENSION_ADAPTER_H`; `#include <stddef.h>` and `<stdint.h>`;
`extern "C"` wrapper; SPDX MIT line; the repo's banner style (purpose, who
includes it, what it is *not*). One sentence of orientation: this header is the
C ABI between `tension-core` (the session) and a capability adapter loaded as a
shared object, and it defines no capability's wasm surface.

## A.1 The rules block

Twelve numbered prose rules, in the repo's convention style:

1. Every entry point is panic-free; any failure comes back as a negative POSIX
   errno; 0 means success for calls that report a status.
2. Ids and handles are 1-based; 0 is never valid.
3. All integers are fixed-width; all lengths are bytes; no `size_t` at this
   boundary (the repo is inconsistent here — `tension_res.h` uses `size_t`,
   `tension_solver.h` uses `uint32_t`; the new header takes `uint32_t` and says
   so).
4. The session calls `init`, `link`, `publish`, `apply`, `shutdown`, `destroy`
   on the interpreter thread. `publish` and `apply` run only while the guest is
   inside a `session::*` call.
5. Adapters never call the guest, from any thread, ever. Callback invocation is
   the session's, exposed only through `call_callback`, which is
   guest-thread-only.
6. Guest memory is reached only through `guest_read` / `guest_write` /
   `guest_size`, and only from the guest thread inside a guest-initiated call.
   Called outside that window they return `-EBUSY`; they never fault and never
   block. Adapters never cache a pointer and never hold a slice across a call.
7. `post_event` is the only function here that may be called from a non-guest
   thread. It never touches guest memory and never blocks.
8. An adapter must not require any symbol from the host executable; every
   service arrives through `tension_core_api`.
9. The wasm module name `session` is reserved to `tension-core`; an adapter
   that registers an import there is refused at load.
10. Adapters must not assume another adapter is loaded, must not read or
    interpret another capability's records or ids, and must not assume they are
    the only event source.
11. `tension_core_api` and `tension_adapter` are append-only within an ABI
    version; changing the meaning of an existing field requires a new
    entry-point symbol.
12. Deferred submissions are **copied** by the session before they are queued;
    an adapter's `apply` receives bytes, never a guest address.

## A.2 Constants

`TENSION_ADAPTER_ABI_VERSION` = 1. `TENSION_ADAPTER_MAX_PARAMS` = 8 (a
registered import takes at most eight scalar parameters).
`TENSION_ADAPTER_MAX_IMPORTS` = 64 per adapter. `TENSION_ADAPTER_MAX_SOURCES`
= 8 event sources per adapter. The twelve session region-kind constants
(A.9), so no adapter hardcodes a magic number.

## A.3 Value types and import shape

`tension_value_type` enum: `TENSION_VT_VOID` = 0, `TENSION_VT_I32`,
`TENSION_VT_I64`, `TENSION_VT_F32`, `TENSION_VT_F64` — a closed set; no v128,
no funcref, documented as closed. `tension_value` union of `int32_t`,
`int64_t`, `float`, `double`. The import function pointer type takes an opaque
`void *ctx`, `const tension_value *args`, `uint32_t nargs`, and
`tension_value *ret`, returning `int32_t` status. Two import flag bits:
`TENSION_IMPORT_DEFERRABLE` (1) and `TENSION_IMPORT_REENTRANT_READONLY` (2),
with the prose from §7.2 about what each obliges and permits.

## A.4 The core API struct

Every field, in declaration order, with signature, thread rule, return, and
semantics:

- `abi_version` (`uint32_t`) — filled by the session; the adapter checks it in
  `init` and refuses on mismatch.
- `user` (`void *`) — opaque session context, stable for the adapter's
  lifetime. It is **not** a per-call pointer: validity of memory access is a
  function of thread and phase, not of this handle.
- `guest_read(user, ptr, dst, len)` → `int32_t` — copies out of the session's
  memory; guest-thread only; `-EBUSY` outside a call, `-EINVAL` on a null
  destination or an out-of-range span. Never partially copies without
  reporting.
- `guest_write(user, ptr, src, len)` → `int32_t` — the mirror; the only write
  path an adapter has.
- `guest_size(user)` → `uint32_t` — the memory's current size in bytes, for
  bounds checking; safe outside a call.
- `resolve_callback(user, table_index, ret_type, param_types, nparams, out_fn)`
  → `int32_t` — resolves once against the guest's exported table and pins the
  signature; `-EINVAL` for a missing export, out-of-range index, null entry, or
  mis-shaped function; `-ENOSPC` if the budget is exhausted.
- `call_callback(user, fn, args, nargs, ret)` → `int32_t` — guest-thread only,
  inside `publish` or `apply`; `-EBUSY` elsewhere. A trap is reported as
  `-EIO`, with the slot already disabled and the fault already published.
- `release_callback(user, fn)` → `int32_t` — idempotent; the session owns the
  storage.
- `log(user, level, msg, len)` → `void` — one stderr line prefixed
  `[tension:session]`; never blocks, never fails; any thread.
- `register_import(user, module, name, ret_type, param_types, nparams, fn,
  ctx, verb_id, flags)` → `int32_t` — valid only during `link`. Refuses an
  unknown value type, more than eight parameters, a duplicate `(module, name)`,
  a name in the reserved `session` module, a duplicate `verb_id` within the
  adapter, or a registration after `link` returned.
- `register_source(user, name, hint, out_source_id)` → `int32_t` — valid only
  during `link`; one per adapter.
- `post_event(user, source_id, class_id, flags, a, b, f0, f1, out_seq)` →
  `int32_t` — any thread. The session builds the record; the adapter posts
  fields. `out_seq` may be NULL. `-ENOSPC` when the class queue is full (a
  hint, not a status update), `-EINVAL` for an unknown class or source.
- `class_info(user, class_id, out_mode, out_capacity, out_flags)` → `int32_t`
  — lets a producer skip generating events nobody subscribes to; `-ENOENT` for
  an unknown class; any thread.
- `region_lookup(user, kind, out_offset, out_size)` → `int32_t` — host-side
  lookup in the frozen layout; no guest access; valid **before**
  `session_open`; `-ENOENT` for a kind not in chunk 1's twelve. The prose says:
  cache at `link`, use in `publish`, offsets are stable for the session's
  lifetime, and individual region sizes are not configurable in chunk 1.

## A.5 The adapter vtable

`abi_version`, `name` (the capability's wasm module name, NUL-terminated
ASCII), `flags`, then: `init(ctx, core)` — checks the ABI version, may block
bounded, no guest memory; `link(ctx, core)` — pure registration, declares
imports and required region kinds, no I/O; `publish(ctx, core)` — once per
epoch, guest thread, bounded work, no blocking, no callback invocation, NULL
means "nothing to publish"; `apply(ctx, verb_id, record, len)` — deferred
submission from copied bytes, depth reset to 0, a non-zero return becomes a
`SUBMISSION_REJECTED` delivery, NULL means no deferrable verbs and is refused if
any import was registered deferrable; `shutdown(ctx)` — idempotent, joins
background threads, no guest memory; `destroy(ctx)` — frees the adapter's
storage, once, after `shutdown`.

## A.6 The entry point

One symbol, `const tension_adapter *tension_adapter_v1(void)`, the only name
the session looks up. The version is in the symbol name so a future
`tension_adapter_v2` can coexist in one object, and a missing symbol is a named
load failure rather than a crash.

## A.7 Error codes at this boundary

A small declared table: 0 success; `-EINVAL` malformed argument or unsupported
shape; `-ENOENT` unknown region kind or class; `-EBUSY` wrong thread or phase,
or a re-entrant call refused; `-EIO` guest callback trapped or fatal adapter
fault; `-ENOSPC` queue full or callback budget exhausted; `-EBADF` session not
READY; `-ENOMEM` allocation failure; `-ENOSYS` a required slot was left NULL.

## A.8 "An adapter must not"

The numbered list from §7.3, verbatim, as the header's closing contract.

## A.9 The twelve region kinds

Values, names, direction, owner, and default sizes (documentation only — sizes
are constants elsewhere; the header documents them so an adapter author can
reason about capacity). Plus the explicit statement from §5.2: chunk 1's region
table is fixed-layout, `kind == index`, and an addition requires a schema bump
or a dynamic-allocation mechanism that chunk 1 does not have.

## A.10 Closing note

This header is frozen at `abi_version` 1; additive fields are appended; the
version check in `init` is mandatory rather than advisory.

---

# Appendix B — A1 execution sequence

Ordered by dependency: probes gate the contract, the contract gates
everything, pure code precedes FFI, FFI precedes wiring, wiring precedes
end-to-end assertions. Thirteen steps over the eleven files.

1. **Run both probes as unit tests** in a stub `src/session/mod.rs`. Nothing
   else is written until they answer, because both can change the header's
   prose (F1, §4.2) and the memory-creation path (F3, §4.1). If the second
   probe fails, the fallback is chosen *here*, before the header text is fixed.
2. **`include/tension_adapter.h`** — per Appendix A. The first real artifact;
   every Rust file, the C fixture, and the loader compile or link against it.
3. **`src/session/arena.rs`** — the twelve kinds, offsets, default sizes,
   `layout_hash`, the control-block / `SessionInfo` / `RegionDesc` / manifest
   writers, and the zeroing and canary helpers as pure functions over a byte
   buffer. No store, no wasmtime; unit-testable, and its tests pin the offsets
   that Rust, C and the wat fixtures all assume.
4. **`src/session/config.rs`** — the TLV key table, the first-key rule, the
   strict decoder, the fixed check order (C1–C4), and the required-region
   truncation check. Mirrors `solver/config.rs`; depends only on step 3.
5. **`src/session/mod.rs`** (real) — memory creation from the declared import
   type, the dual `env`/`session` definition, the pre-instantiation structural
   write and zeroing, the post-instantiation verification hook,
   `session_open` / `session_close`, the state machine, and the permanent home
   for the first probe as a regression test. Depends on 2, 3, 4.
6. **`src/adapter/signatures.rs`** — the closed value-type set, arity and type
   validation, the argument-packing rule, and the import table's bounds. Pure
   Rust, no wasmtime: the cheapest file in the set and independent of
   everything except the header's enum values.
7. **`src/adapter/ffi.rs`** — the `#[repr(C)]` mirrors of A.3–A.5,
   `dlopen`/`dlsym`/`dlclose`, the version check, and the closure factory that
   turns a registered `tension_import_fn` into a linker import. Depends on 2
   and 6.
8. **`src/adapter/mod.rs`** — the registry: load by path, resolve
   `tension_adapter_v1`, drive `init`/`link`, refuse duplicate imports and
   reserved-`session` registrations, collect declared required regions, and
   expose one `link_adapters` call. Depends on 5, 6, 7.
9. **`tests/support/echo_adapter.c`** — the reference adapter: one arithmetic
   import, one that round-trips bytes through `guest_write`/`guest_read`, one
   `log` line, `publish` and `apply` left NULL, and `region_lookup` called in
   `link` to prove the pre-open query works. Compiles against the header alone,
   with no host symbols. May be written in parallel with 3–8.
10. **`build.rs`** — compile the echo adapter into `OUT_DIR`, plus a second
    build of the same source with `-DECHO_BAD_ABI_VERSION` into a second `.so`
    (this is how the version-refusal path is proven without adding a twelfth
    file), and export both paths via `cargo:rustc-env`. Depends on 9.
11. **`tests/fixtures/session_guest.wat`** and
    **`tests/fixtures/bad_memory_guest.wat`** — the first imports
    `("session","memory")`, re-exports it as `"memory"`, exports
    `_start_game`, calls `session_open`, reads `ArenaControl.magic` at offset 0
    and asserts `SessionInfo.maxArenaSize`, calls the echo imports, prints. The
    second declares a memory type that cannot match the provided one. Their
    constants come from step 3.
12. **`src/main.rs`** — the wiring and the three load-time checks (§11), memory
    creation before `linker.instantiate`, `session::link_session`,
    `adapter::link_adapters`, the post-instantiation structural verification,
    and only then `_start_game`. Depends on everything above.
13. **`tests/session_smoke.rs`** — the end-to-end assertions: happy path;
    `-EBADF` from every verb before `session_open`; missing-memory-import
    refusal; missing-memory-export refusal; `bad_memory_guest` refused with the
    C3 diagnostic; bad-ABI-version adapter refused at load; duplicate-import
    adapter refused. Last, because it exercises all of the above.

**A1 is complete when** `cargo test` for `tension-core` is green including step
13, the probes are permanent regression tests rather than scratch, no
AssemblyScript has been compiled, no line of OGRE exists in the tree, and the
memory relation has been exercised in both the matching and mismatching
directions at least once.
