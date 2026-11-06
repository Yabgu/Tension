# DESIGN.md — the 2D capability

This is the design for `tension-2d`: the capability adapter that exposes SDL_GPU's
pipeline surface to a Tension guest as the 2D renderer, and the pipeline compiler
that turns a guest-supplied graph into the shaders and draw calls that run it.

**Status: scaffolded.** `tension-2d/` now contains the adapter this document
describes — `include/tension_2d.h`, `src/adapter.cpp`, `src/render.cpp`,
`src/texture.cpp` — plus the cost probe under `bench/`. It builds with
`node scripts/build-2d.mjs` and passes `node scripts/test-2d.mjs`, which draws
ten sprites at known positions through the full ABI and reads the pixels back.

What is **not** built is §6: the graph compiler. `set_pipeline` accepts the
built-in preset by id and answers `-ENOSYS` for a guest blob, so §6 remains a
design and is still the section to contest first. §14 records exactly what the
scaffold does and does not do.

The relationship to the rest of the tree:

- `tension-core/include/tension_adapter.h` owns the boundary this adapter
  implements. It is at **ABI version 4**, and this document does not propose a v5.
- `tension-input/DESIGN.md` is the structural model: a capability that owns **no
  regions**, exposes **verbs only**, and records what it measured. §2 and §4
  follow it deliberately.
- `tension-ogre/DESIGN.md` §1–§2 own the broker decision this document inherits,
  and §8.1 owns the render-thread rules it re-uses.
- `tension-shadergen` is the crate the graph compiler extends. It is not replaced
  and not forked.

Where the tree contradicts the settled architecture, this document says so in the
section that depends on the claim, and again in §13. Two such contradictions are
recorded and neither is papered over: ImageViewer exposes no decode-to-format
entry point (§8), and the crate's vocabulary seam had no implementation outside
itself until this document's conformance spike supplied one (§6.7). A third —
`tension-shadergen`'s vertex model could not express a 2D sprite quad — was found
by that spike and has since been fixed (§6.7.1).

The document was revised after its first draft measured four things it had
asserted: the record is 28 bytes rather than 26 (§5), the sprite-batch cost is
0.10–0.25 ms rather than the 0.06 ms it quoted (§7), ImageViewer is Apache-2.0
rather than MIT (§10), and `iw_decode_to_format` does not exist (§8). Each change
says so where it lands.

---

## 1. Philosophy

**The adapter is a broker.** It exposes SDL_GPU's pipeline surface to the guest
and carries no pipeline-feature knowledge of its own. This is `tension-ogre`'s
rule applied to a different engine: "the adapter carries OGRE's own contract
faithfully, the core carries none of it, and this document describes the boundary
between them rather than a rendering API of Tension's invention"
(`tension-ogre/DESIGN.md` §1). The same sentence holds here with SDL_GPU in place
of OGRE.

**The pipeline is a graph, the graph is data, the compiler is the engine.** A
pipeline — how records become vertices, how vertices are ordered, what the
fragment stage does — is a serialized graph the guest hands to `set_pipeline`. It
is not a set of flags on a call, and it is not an enum the adapter switches on.
The adapter parses it, validates it, lowers it, and runs it. It does not know what
"isometric" means, and it should never need to.

Three rules follow, and they constrain every section below:

1. **No enum for pipeline features.** There is no `PipelineFeature` and no
   `SortRule` in this design. Any such enum is a closed set of the shapes we
   thought of, which is exactly the set the first unanticipated game exceeds.
   Where a shape is common, it ships as a **preset graph** (§6), which is data of
   the same kind a guest can write.

2. **No switch on graph opcodes outside the frontend.** The opcode set is
   interpreted in exactly two places — the Cranelift lowering and the GLSL
   lowering, both in the compiler — and nowhere else. The adapter's rendering
   path (§7) sees a compiled pipeline object: a pipeline handle, a vertex layout,
   a storage buffer, a draw count. If a `match op` appears in `present` or in the
   bucket loop, this design has been violated.

3. **No rebuild for a new pipeline shape.** A guest adding a pipeline is a
   `set_pipeline` call with different bytes. Nothing in the adapter, the core, or
   the build changes. The test of this rule is that a new shape costs a `pipe_id`
   and nothing else.

The consequence worth stating plainly: the guest is trusted to describe its own
pipeline, and the host is trusted to validate the description before compiling it
(§6). This is the same trust posture as `shader_compile_raw` (§3), reached by a
safer route — the graph is checked, the raw shader is not.

---

## 2. ABI posture

**Version 4, and the adapter does not bump it.** `TENSION_ADAPTER_ABI_VERSION` is
`4u` (`tension-core/include/tension_adapter.h:80`), the vtable is append-only
within a version (rule 11), and the 2D capability fits inside what v4 already
offers. A new import namespace is not a vtable change: `register_import` takes the
module name as an argument (`tension_adapter.h:278`), and a capability's module
name is its own (`tension-ogre/DESIGN.md` §2).

The 2D adapter's vtable is `tension-input`'s, field for field
(`tension-input/src/adapter.cpp:328–341`):

| field | value | why |
| --- | --- | --- |
| `abi_version` | `TENSION_ADAPTER_ABI_VERSION` | the load check; never a literal |
| `name` | `"tension::2d"` | the wasm module this implements |
| `flags` | `0` | reserved |
| `init` | present | creates the GPU thread and the device |
| `link` | present | registers the nine imports |
| `publish` | `NULL` | **owns no regions** |
| `apply` | `NULL` | no deferrable verb |
| `shutdown` | present | joins the GPU thread, releases the device |
| `destroy` | present | the DSO's own teardown |
| `layout_hash` | `TENSION_ADAPTER_LAYOUT_HASH` | `786288195u` (`tension_adapter.h:100`) |

**Owns no regions.** `publish` is `NULL` for the same reason it is in
`tension-input` (`tension-input/DESIGN.md` §5: "No regions. The vtable's `publish`
is `NULL` — the adapter owns none"). Sprites, pipelines and textures reach the
renderer through verbs, not through a shared region. A region would be the right
shape for state a consumer must read from inside a callback; 2D state is consumed
by the adapter, not by the guest, so a region would be a copy in the wrong
direction.

**`apply` is `NULL` because no verb is deferrable.** `TENSION_IMPORT_DEFERRABLE`
exists for verbs callable from inside a callback, whose submission the session
copies and replays after the batch (`tension_adapter.h:187`, rule 12).
`submit` could qualify, and it deliberately does not (§3): its answer is a count
the caller uses to decide whether to split a bucket, and a deferred call cannot
answer.

**State crosses through verbs.** There is no status table and no mirror. The
guest's pipeline registry is whatever `pipe_id`s it was handed; its texture
registry is whatever ids `texture_load` returned. The adapter keeps no
guest-visible state that the guest cannot recover from its own records, which is
what makes `close` a complete teardown rather than a partial one.

**`-ENODEV` is outside the boundary's closed errno list.** The list is
`0, -EINVAL, -ENOENT, -EBUSY, -EIO, -ENOSPC, -EBADF, -ENOMEM, -ENOSYS`
(`tension_adapter.h:530–540`); none of those names "no GPU device, no window, no
swapchain". This is the same deviation `tension_ogre.h` and
`tension_input.h:222–238` already carry, with the same amendment: one line in that
list, owed by `tension-core`. Until it lands, `tension_2d.h` is the third header
where the deviation is recorded, and the amendment text should name all three.

---

## 3. The ten verbs

The module is `tension::2d`. Ids are 1-based and stable — a reused id is a silent
misroute, not a compile error. Every signature is `i32` at the wasm boundary
(`tension_adapter.h` rule 3: no `size_t`, guest pointers and lengths are
`uint32_t`). At most 8 scalar parameters (`TENSION_ADAPTER_MAX_PARAMS`), so
`shader_compile_raw` fits with three to spare.

| # | verb | signature | returns | flags |
| --- | --- | --- | --- | --- |
| 1 | `open` | `(i32 width, i32 height, i32 flags) -> i32` | handle | 0 |
| 2 | `close` | `(i32 handle) -> i32` | 0 | 0 |
| 3 | `set_pipeline` | `(i32 handle, i32 blob_ptr, i32 blob_len) -> i32` | `pipe_id` | 0 |
| 4 | `shader_compile_raw` | `(i32 handle, i32 vs_ptr, i32 vs_len, i32 fs_ptr, i32 fs_len) -> i32` | `pipe_id` | 0 |
| 5 | `submit` | `(i32 handle, i32 pipe_id, i32 hdr_ptr, i32 z_bucket) -> i32` | record count | 0 |
| 6 | `present` | `(i32 handle) -> i32` | 0 | 0 |
| 7 | `texture_load` | `(i32 handle, i32 src_ptr, i32 src_len, i32 target_format) -> i32` | texture id | 0 |
| 8 | `info` | `(i32 handle, i32 ptr, i32 cap) -> i32` | bytes written | `REENTRANT_READONLY` |
| 9 | `screenshot` | `(i32 handle, i32 ptr, i32 cap) -> i32` | bytes written | 0 |
| 10 | `set_texture` | `(i32 handle, i32 pipe_id, i32 slot, i32 texture_id) -> i32` | 0 | 0 |

**`open(i32 width, i32 height, i32 flags) -> i32`** — verb 1. Creates the GPU
thread, `SDL_CreateGPUDevice`, the offscreen target at `width` x `height`, and the
one session. Returns the handle, 1-based. Errors: `-EINVAL` (`width`/`height`
outside 1..16384, or `flags != 0`; no flags are defined), `-EBUSY` (a session is
already open; capacity 1, declared), `-ENODEV` (no GPU device on this machine),
`-ENOSYS` (this SDL build has no GPU backend), `-EIO` (device creation failed for a
reason SDL can name), `-ENOMEM` (the target could not be allocated). Like
`input_open`, this is where the refusal lives, not `init`
(`tension-input/DESIGN.md` §3: load returns 0 either way; the retry is here).

The canvas is the caller's decision, fixed for the handle's life; a resize is
`close` + `open`, because v1 has no swapchain to renegotiate with. The 16384
ceiling is Vulkan's guaranteed `maxImageDimension2D`, so a size this verb accepts
is one every conformant device can allocate. `info` echoes the size back, so a
guest sizes its readback without trusting its own memory of the call.

**`close(i32 handle) -> i32`** — verb 2. Releases textures, pipelines, buffers,
the swapchain, the device, and joins the thread. Returns 0, `-EINVAL` for an
unknown handle. This is the teardown that actually runs: the host never calls the
vtable's `shutdown`/`destroy` (`tension-input/DESIGN.md` §3, `SESSION.md` §11 M3),
so a capability that owns a thread must release it through a verb and must
survive being unloaded without one.

**`set_pipeline(i32 handle, i32 blob_ptr, i32 blob_len) -> i32`** — verb 3. The
blob is a serialized pipeline graph (§6). Returns a `pipe_id`:

| range | meaning |
| --- | --- |
| 1–99 | built-in presets. `blob_ptr == 0` addresses one directly: `blob_len` is the preset id (1–9 today, `tension-shadergen/src/lib.rs:175`). The returned id equals the preset id. |
| 100–999 | guest-authored graphs, hashed from the blob bytes (§6) |
| 1000+ | provenance of `shader_compile_raw` |

The id ranges are a diagnostic contract, not a permission system: a `pipe_id` in
the 1000s tells a log reader that this pipeline's shaders were never validated by
the frontend. Errors: `-EINVAL` (bad handle, malformed or unparseable blob, or
any validation failure from §6), `-ENOENT` (preset id outside 1–9), `-ENOSYS` (the
graph names an opcode, or uses a record type, this build's compiler cannot lower),
`-ENOSPC` (the pipeline table is full), `-EIO` (shader translation or pipeline
creation failed).

The "blob_ptr == 0 means preset" encoding is a decision this document makes
because the tree does not settle it; §12 records the alternative.

**`shader_compile_raw(i32 handle, i32 vs_ptr, i32 vs_len, i32 fs_ptr, i32 fs_len)
-> i32`** — verb 4. The trust-users door. It takes two shader sources, translates
them (GLSL → SPIR-V, §7), creates the pipeline, and returns an id ≥ 1000. There is
no validation beyond the minimum needed not to crash: the sources must be UTF-8,
must declare an entry point, and must translate. Nothing checks the vertex layout
against the shader's attributes, because there is no layout to check it against —
that is what the guest gave up by not sending a graph.

The header must state the risk in the same voice the rest of the boundary uses,
not weaker: *a raw shader is arbitrary code in the GPU driver. It is the guest's
own code, in the guest's own process, so this is a correctness hazard and not a
sandbox escape — the guest could already write into any buffer it was given. What
it removes is the host's ability to answer "what does this pipeline do" without
reading the source, and it is why the `pipe_id` range exists.* Errors: `-EINVAL`
(bad handle, not UTF-8, no entry point), `-EIO` (translation or pipeline creation
failed, with SDL_shadercross's message logged), `-ENOSPC` (pipeline table full),
`-ENOSYS` (no shadercross in this build).

**`submit(i32 handle, i32 pipe_id, i32 hdr_ptr, i32 z_bucket) -> i32`** — verb 5.
The shape is unchanged from the settled architecture. A `pipe` carries layout,
sort, shader and buffers; `submit` supplies instances of it, one bucket at a time.
`hdr` is a 16-byte guest header:

```
u32 records_ptr    guest address of the record array
u32 records_count  number of records
u16 record_stride  bytes per record (must equal the schema's record_size)
u16 flags          must be 0
```

Returns the number of records accepted. **One `guest_read` per submit**, copying
the whole array into the adapter's bucket staging buffer (§4). Errors: `-EINVAL`
(bad handle, bad header, `record_stride` disagrees with the schema, or a field
offset in the schema exceeds the record), `-ENOENT` (unknown `pipe_id`),
`-EBUSY` (no pipeline set for this bucket), `-ENOSPC` (the bucket's staging buffer
is full; the caller splits and re-submits — this is why the count is returned),
`-EFAULT`-shaped refusal via `guest_read`'s own errno when the array is not
readable.

`z_bucket` is the bucket index within the stage, not a depth. Depth lives in the
record's `sort_key` and is resolved by the graph (§5, §6). A bucket is a draw call
(§7); the guest chooses how to spread its records across them.

**`present(i32 handle) -> i32`** — verb 6. Ends the frame: waits for the
swapchain texture, submits every bucket recorded since the last `present`, presents.
In headless mode (§9) it submits to the offscreen target and is otherwise a no-op.
Errors: `-EINVAL` (bad handle), `-EIO` (swapchain acquisition or submission
failed), `-ENODEV` (no window and no offscreen target).

**`texture_load(i32 handle, i32 src_ptr, i32 src_len, i32 target_format) -> i32`**
— verb 7. Takes encoded bytes — IW, PNG, or JPEG — decodes them, and uploads one
`SDL_GPUTexture` in `target_format`. `src` is guest memory, read once. Returns a
texture id (1-based). Errors: `-EINVAL` (bad handle, unknown `target_format`,
empty source), `-ENOSYS` (a container this build's decoder does not serve),
`-EIO` (decode failed), `-ENODEV` (no device), `-ENOMEM` (allocation). §8 is the
whole of this verb's design.

**`set_texture(i32 handle, i32 pipe_id, i32 slot, i32 texture_id) -> i32`** —
verb 10. Binds a loaded texture to one **page** of a pipeline's texture array.
A record's `tex` is the page it samples, so this is what gives the field meaning.
Errors: `-EINVAL` (bad handle, `slot` outside 0..15, or a texture whose dimensions
disagree with the pipeline's array), `-ENOENT` (unknown `pipe_id` or
`texture_id`), `-ENOMEM` (array allocation), `-EIO` (the GPU copy failed).

The array is one `SDL_GPUTexture` of `TENSION_2D_MAX_ATLAS_PAGES` (16) layers, so
every page of one pipeline is the same size — an array texture has one size. A
page that disagrees is refused rather than resampled: the record's src rect is in
pixels, and resampling would move pixels inside a cell. A pipeline with **no**
bound pages samples the most recently loaded texture at page 0, which is the
single-atlas behaviour v1 shipped with, so a caller that never calls this verb is
unaffected.

**`info(i32 handle, i32 ptr, i32 cap) -> i32`** — verb 8. A fixed 24-byte record:
`{u16 version, u16 max_records, u32 max_textures, u32 max_pipelines, u16 max_buckets,
u16 flags, u32 canvas_width, u32 canvas_height}`. Read-only, re-entrant
(`TENSION_IMPORT_REENTRANT_READONLY`, `tension_adapter.h:191`), so a callback may
ask how much room it has. Errors: `-EINVAL`, `-ENOSPC` (short buffer).

**`screenshot(i32 handle, i32 ptr, i32 cap) -> i32`** — verb 9. Reads back the
last presented frame as RGBA8 into guest memory (§9). Not re-entrant: it waits for
the GPU, which no callback may do. Errors: `-EINVAL`, `-ENODEV` (nothing has been
presented), `-ENOSPC` (`cap` is smaller than width × height × 4), `-EIO`.

**Why none of these is deferrable.** `TENSION_IMPORT_DEFERRABLE` moves a call after
the guest's batch, and the session copies the submission's bytes (rule 12:
"Deferred submissions are *copied* by the session before they are queued. An
adapter's `apply` receives bytes"). `submit`'s whole answer is a count computed
from input it would no longer have; `present`'s whole purpose is ordering relative
to the guest's frame. Exposing either as deferrable would give the guest a call
that looks synchronous and is not.

---

## 4. Memory model

**One-way, one-read, no retention.** Every pointer argument in §3 is a guest
address, valid only for the duration of the call, read with `guest_read` and never
stored. Rule 6 of `tension_adapter.h` is the whole model: "An adapter never caches
a pointer into guest memory and never holds a slice across a call."

`submit` is the only verb that moves bulk data, and it does one `guest_read` for
the entire record array. Not one per record: a 10k-sprite bucket would otherwise
be 10k calls into the interpreter for data that is already contiguous.

**Released after the call.** The bytes land in the adapter's staging buffer for the
bucket, which is uploaded and then reused next frame (§7). The adapter's copy is
the only copy it keeps, and it is keyed by bucket, not by guest address.

**`@unmanaged @dynamic` records.** A record array is unmanaged — the guest owns
the memory, the adapter never sees a GC reference — and dynamic, in the sense that
nothing about the array's address or lifetime is fixed across calls. This is what
the ABI already assumes: a `u32` guest pointer, dereferenced inside a call, is the
only pointer shape `guest_read` accepts.

**`@managed` is rejected, and the reason is mechanical.** A managed record array
would be a GC reference the adapter holds across a call, so the collector would
have to root it — and the adapter is not a root. It has no way to tell the
collector it is holding something, no way to be told the object moved, and no
`user` handle the collector knows about. Accepting a managed array would mean
either pinning (a GC contract this ABI does not have) or copying at
`session_open` time (a lifetime the guest cannot express). Neither is available,
so the refusal is `-EINVAL` on a header flag that would request it — and there is
no such flag in §3's header, which is the refusal.

---

## 5. Record layout

The `sprite` preset's record, 28 bytes:

```
offset  field       type   bytes
  0     x           i32      4
  4     y           i32      4
  8     src_x       u16      2
 10     src_y       u16      2
 12     w           u16      2
 14     h           u16      2
 16     tex         u16      2
 18     —           pad      2
 20     sort_key    u32      4
 24     group_id    u16      2
 26     z           u8       1
 27     flags       u8       1
       total               28
```

Two bytes at offset 18 are padding. They buy the natural alignment discussed at
the end of this section, and they are named in the schema rather than left to a
compiler, so the descriptor a guest sends and the bytes it writes cannot
disagree about them.

**`x`, `y`** — world position in whole pixels, signed so a sprite may be partly
or wholly off-canvas. Clip-space conversion happens in the graph's `emit_vertex`,
where the canvas size is available; the record never contains a normalized
coordinate, because a record that can only describe one canvas is a record that
cannot be cached across a resize.

**`src_x`, `src_y`, `w`, `h`** — the sub-rectangle within the atlas page. This is
where animation lives: a frame is four `u16`s, and the graph computes them from a
frame index and the atlas's frame table (`atlas_frame`, §6) rather than the guest
rewriting them per frame. A guest that animates on the CPU may write them
directly; both are the same record.

**`tex`** — the atlas page index, `u16`. The adapter implements multi-atlas as a
16-layer texture array per pipeline (`set_texture`, §3): the shader reads `tex`
and samples `texture2DArray` at that layer, so one instanced draw covers several
atlas pages without splitting the bucket — which is what keeps multi-atlas from
overruling the sort. All pages of one pipeline share the array's dimensions.
Oversized tilesets are the case that needs it; the framework layer computes `tex`
per tile, the adapter never invents one.

**`sort_key`** — depth, `u32`, written by the graph. Larger sorts later. The field
is `u32` rather than `f32` because a sort key that compares equal should compare
*equal*, not nearly equal: a total order over integers is what makes
`sort_stable` deterministic, and determinism is what makes a bucket's draw order
reproducible between runs.

**`group_id`** — composite grouping, `u16`. Records sharing a group are emitted
consecutively within a bucket, which is what lets a modular character's torso,
head and weapon be three records that sort as one unit and then order among
themselves by `z`.

**`z`** — within-group order, `u8`. 256 layers per composite is enough; the pair
`(group_id, z)` is the composite's own sort key, and the graph composes it.

**`flags`** — eight bits the adapter assigns **no meaning to**. The shipped
`sprite` preset graph interprets bit 0 as flip-horizontal, bit 1 as
flip-vertical, bit 2 as "visible" and bit 3 as "additive"; a guest graph may
reinterpret all eight. This is rule 1 (§1) at field granularity: the record carries
data, the graph carries meaning, and a new rendering hint is a new graph rather
than a new bit the adapter must learn.

**No anchor in the record.** Anchor — the hotspot a sprite rotates and sorts
around — is metadata in the atlas, resolved by `anchor_from_atlas` and consumed by
the graph, which folds it into `sort_key` and the emitted position. Putting it in
the record would cost 4 bytes per sprite for a value that is constant per frame
of animation, and would let a guest disagree with its own atlas.

**Physics never reads `sort_key`, `group_id`, or `z`.** Those three fields exist
for the renderer's ordering and for nothing else. A physics step that read them
would make draw order a simulation input, and a guest that reordered sprites
would change its collisions. The record's first 18 bytes are the geometry and the
source rect; bytes 18–19 are padding; the last 8 are presentation.

**No packed records; natural alignment only.** Every field starts at an offset
that is a multiple of its own width — `x` and `y` at 0 and 4, the six `u16`s on
even boundaries, `sort_key` at 20, and the record's size (28) a multiple of its
widest member (4). Shaders use a std430 struct over the storage buffer, so a
field's offset is the offset std430 computes rather than a number the lowering
has to reproduce by hand. `tension-shadergen::validate()` checking
`offset + width <= record_size` is then sufficient: with natural alignment there
is no second, invisible constraint for it to miss.

This is a change from the first draft, which shipped a 26-byte packed record with
`sort_key` at 18. That version forced the lowering to index the buffer by
explicit byte offset and forbade a std430 struct, because std430 would have
placed the `u32` at 20 and read the wrong bytes. Two bytes of padding costs 7%
of the record and removes a whole class of lowering bug; §12 records the decision
as resolved.

---

## 6. The pipeline graph

This is the load-bearing section. Everything else in this document is a
consequence of it.

### 6.1 What a graph is

A graph is a **stage**: a list of nodes over a record schema, with one canvas and
one output. A pipeline is one vertex stage and one fragment stage. The guest
supplies the graph; the compiler supplies the lowering; the adapter supplies the
storage buffer and the draw call.

The graph is deliberately shaped like a dataflow over *records*, not over
*vertices*. The unit of work is "one record in, zero or more vertices out". That
is what makes a 10k-sprite frame one draw with a 10k-instance buffer instead of
60k expanded vertices, and it is why the graph's terminator is `emit_vertex`
rather than an assignment to `gl_Position`.

### 6.2 Blob format

Canonical binary, little-endian, fixed-width:

```
header (24 bytes)
  u16 magic             0x3254  ('T','2' little-endian)
  u16 version           1
  u16 record_count
  u16 stage_count
  u32 record_table_off  byte offset from blob start
  u32 stage_table_off
  u32 total_len         must equal blob_len; trailing bytes are -EINVAL
  u32 reserved          must be 0

record table, record_count entries:
  u16 name_len, u8[name_len] name         UTF-8, diagnostics only
  u16 field_count
  field[field_count]:
    u16 name_len, u8[name_len] name
    u16 offset           bytes from record start
    u16 dtype            TENSION_DTYPE_*   (tension_adapter.h:132–135)
    u16 semantic         TENSION_SEM_*     (tension_adapter.h:117–130)
    u16 reserved         must be 0

stage table, stage_count entries:
  u16 name_len, u8[name_len] name
  u16 canvas_w, canvas_h
  u16 schema           index into the record table
  u16 node_count
  node[node_count]:
    u16 op               the opcode, §6.3
    u16 out              slot id this node's result occupies
    u16 argc
    u16 arg[argc]        slot ids, or small integer literals where §6.3 says so
  u16 output           the slot id of the stage's terminator (emit_* / composite_emit)
  u16 reserved
```

Slots are single-assignment, referenced by id, numbered densely from 1. There is
no phi, no control flow and no loops: a graph is a straight-line expression over
one record, plus list operations over the whole bucket (§6.4). Anything a game
wants that needs branching is expressed as `select`, and anything that needs a
loop is expressed as a list operation.

`version` is checked, not negotiated. A blob from a newer compiler is `-ENOSYS`
(the host does not know the format), not a best-effort parse.

**Why binary, when JSON would be easier to debug.** The rationale is in §12, where
it is an open question with a stated preference rather than a closed decision.

### 6.3 The opcode set

The set is a **proposal**, not frozen. §6.6 marks which ops are load-bearing for
the three known 2D problems and which are speculative. Ids 1–39, append-only —
an id that changes meaning between builds is a silent misinterpretation once a
cached pipeline outlives a rebuild.

Type grammar: `rec` (one record), `i32`, `u32`, `f32`, `bool`, `rect`, `vec2`,
`vec4`, `list` (the bucket's records, or a permutation of them), `void`.

**Record access and constants**

| id | op | arity | signature | semantics |
| --- | --- | --- | --- | --- |
| 1 | `load_field` | 2 | `(rec, field_idx) -> T` | the field's value at its schema offset and dtype; the only way a record is read |
| 2 | `store_field` | 3 | `(rec, field_idx, T) -> rec` | a modified copy; the frontend proves the write is confined to this record |
| 3 | `record_at` | 2 | `(list, idx) -> rec` | element access inside a whole-bucket op |
| 4 | `const_i32` | 1 | `(literal) -> i32` | `argc == 1`, the arg is the value, not a slot |
| 5 | `const_f32` | 1 | `(literal_bits) -> f32` | the arg is an IEEE-754 bit pattern in the low 16 bits of a float32 table index… see note |

*Note.* Two literal forms are needed and only one fits the node encoding: at v1 a
`const_f32` arg indexes a per-stage constant pool appended after the node array.
That is a wart of packing literals into `u16` args; the alternative — a wider node
record — costs 4 bytes per node for every graph. Recorded in §12.

**Arithmetic**

| id | op | arity | signature | semantics |
| --- | --- | --- | --- | --- |
| 6 | `add` | 2 | `(T, T) -> T` | wrapping for integers, IEEE for f32 |
| 7 | `sub` | 2 | `(T, T) -> T` | |
| 8 | `mul` | 2 | `(T, T) -> T` | |
| 9 | `div` | 2 | `(T, T) -> T` | integer division truncates; division by zero is `-EINVAL` at compile time only when both operands are constants |
| 10 | `neg` | 1 | `(T) -> T` | |
| 11 | `floor` | 1 | `(f32) -> i32` | pixel snapping |
| 12 | `sqrt` | 1 | `(f32) -> f32` | |

**Compare and select**

| id | op | arity | signature | semantics |
| --- | --- | --- | --- | --- |
| 13 | `cmp_lt` | 2 | `(T, T) -> bool` | |
| 14 | `cmp_eq` | 2 | `(T, T) -> bool` | exact for integers, bitwise for f32 — no epsilon |
| 15 | `select` | 3 | `(bool, T, T) -> T` | `cond ? a : b`; the only branch |

**Composition**

| id | op | arity | signature | semantics |
| --- | --- | --- | --- | --- |
| 16 | `tuple` | n | `(T…) -> tuple` | builds a multi-value result |
| 17 | `tuple_get` | 2 | `(tuple, idx) -> T` | |
| 18 | `rect` | 4 | `(i32, i32, u16, u16) -> rect` | x, y, w, h |

**Ordering (whole-bucket ops)**

| id | op | arity | signature | semantics |
| --- | --- | --- | --- | --- |
| 19 | `sort_ascending` | 1 | `(list<key>) -> perm` | a permutation, not a reordered list: indices, so every other field follows for free |
| 20 | `sort_stable` | 1 | `(list<key>) -> perm` | stable; equal keys keep submission order |
| 21 | `gather` | 2 | `(list, perm) -> list` | applies a permutation to any list — the reason `sort_*` returns `perm` |
| 22 | `group_by` | 2 | `(list<key>, list<key>) -> perm` | lexicographic on two key lists, i.e. `(group_id, z)` in one op |

**Geometry and output**

| id | op | arity | signature | semantics |
| --- | --- | --- | --- | --- |
| 23 | `make_quad` | 3 | `(rec, rect, u32 flags) -> quad` | corners from position and source rect; the flip bits live in the third arg |
| 24 | `emit_vertex` | 2 | `(quad, corner_idx) -> void` | one vertex; the terminator per corner |
| 25 | `emit_index` | 1 | `(quad) -> void` | six indices for one quad |
| 26 | `composite_emit` | 2 | `(list, perm) -> void` | emits every record in permuted order into one bucket |
| 27 | `cull` | 3 | `(rec, rect, bounds) -> bool` | a reject test the frontend may fold into 26 |

**Texture and colour**

| id | op | arity | signature | semantics |
| --- | --- | --- | --- | --- |
| 28 | `tex_sample` | 3 | `(uv, tex, sampler) -> vec4` | fragment stage only; `tex` selects the binding |
| 29 | `tint` | 2 | `(vec4, vec4) -> vec4` | component-wise |
| 30 | `blend` | 3 | `(u32 mode, vec4, vec4) -> vec4` | fixed-function modes named by `u32`, resolved to the pipeline's blend state at compile time |
| 31 | `atlas_frame` | 3 | `(atlas_meta, i32 frame, u32 fps) -> rect` | the animation op: frame index in, source rect out |

**Derived quantities**

| id | op | arity | signature | semantics |
| --- | --- | --- | --- | --- |
| 32 | `anchor_from_atlas` | 2 | `(atlas_meta, tex) -> vec2` | the hotspot for this atlas page |
| 33 | `parallax_offset` | 2 | `(camera, f32 factor) -> vec2` | the intrinsic that stands in for per-frame uniforms (§11) |
| 34 | `world_to_clip` | 3 | `(vec2, rect, rect) -> vec2` | canvas size in, clip space out |
| 35 | `sin` | 1 | `(f32) -> f32` | |
| 36 | `cos` | 1 | `(f32) -> f32` | |
| 37 | `abs` | 1 | `(T) -> T` | |
| 38 | `min` | 2 | `(T, T) -> T` | |
| 39 | `max` | 2 | `(T, T) -> T` | |

### 6.4 The graph is not an enum

The test of §1's rule 1 is that the common shapes are written *in* the graph
language rather than named after it. "Anchor sort" — the thing an engine would
have as `SORT_RULE = ANCHOR` — is three nodes:

```
load_field(anchor_y)      -> a     # from the atlas, via anchor_from_atlas + load_field
load_field(world_y)       -> b
sub(a, b)                 -> c     # anchor_y + world_y, sign by convention
sort_ascending(c)         -> perm
```

and isometric depth is the same shape with a different expression feeding it:

```
load_field(x)  -> a
load_field(y)  -> b
add(a, b)      -> c        # x + y is the isometric depth axis
sort_ascending(c) -> perm
```

There is no `isometric` opcode and there will not be one. The difference between
the two pipelines is four bytes of opcode choice, which is the whole point: the
adapter's code is identical, and the compiler never learns the word.

### 6.5 Two lowerings, one graph

| lowering | consumes | produces | runs |
| --- | --- | --- | --- |
| **Cranelift (CPU)** | whole-bucket ops — 19–22, 26, 27 | machine code over the staging buffer | per bucket, per frame |
| **GLSL → SPIR-V (GPU)** | per-record ops — 1–18, 23–25, 28–39 | vertex and fragment source, then SPIR-V | once per pipeline |

The split is not arbitrary: ops over `list` have to see every record, and no
vertex shader invocation does. Ops over `rec` are per-instance and belong on the
GPU. A graph that mixes them (sorting then emitting per-instance) is lowered in
both and the boundary is the permutation: the CPU produces `perm`, the GPU reads
the buffer in that order.

Cranelift is not a new dependency. It is already in the tree transitively through
Wasmtime (`tension-core/Cargo.lock:319–414`,
`wasmtime 24.0.13` at `:2014`), Apache-2.0 with the LLVM exception (§10). Using the
already-present copy is the difference between adding a code generator and using
the one the process links.

The GPU path is `tension-shadergen` extended, not replaced: `LayoutDesc`,
`ShaderGenerator`, the nine presets and the `-ENOSYS` discipline
(`tension-shadergen/src/lib.rs:28–175`) are the target the graph compiles *into*.
`generate_vertex` today emits attributes from a `LayoutDesc`; the graph compiler's
job is to derive that `LayoutDesc` from the record schema and to extend the
emission with the per-record expression.

`DefaultGenerator` returns both stages in one string separated by
`// ---- fragment ----` (`tension-shadergen/src/lib.rs:370–382`) because the C ABI
has one output buffer. The compiler keeps that contract.

### 6.6 Load-bearing versus speculative

Thirty-nine ops are listed and the brief asked for roughly thirty. The count is
accounted for here so a reviewer can cut without guessing: twenty-six correspond
to the twenty-five the brief named (its `cmp` is split into `cmp_lt`/`cmp_eq`, and
its `group` is `group_by`), and thirteen are additions this document proposes
because the three known 2D problems need them.

**Load-bearing for oversized tilesets.** A tileset that exceeds one texture page
is the case that forces multi-atlas, and the ops that make it cheap are
`load_field` (`tex`), `atlas_frame`, `tex_sample`, `make_quad`,
`emit_vertex`/`emit_index`, `cull` and `world_to_clip`. The shape is: the record
names its page, the graph binds it, and the draw is per page. Without `tex` in
the record the page would have to be a pipeline-level binding, which turns a
tileset that spans two pages into two pipelines and a sort the guest has to do
itself.

**Load-bearing for isometric depth.** `load_field` (`x`, `y`, `anchor_y`),
`add`/`sub`, `cmp_lt`, `sort_ascending`, `sort_stable`, `gather` and
`anchor_from_atlas`. This is the whole reason `sort_*` returns a permutation
rather than a sorted list: every other field has to follow the sort, and
`gather` is the one op that applies a permutation to any list. Isometric depth is
`x + y` sorted ascending, with a stable tie-break so two sprites at the same
depth do not flicker between frames.

**Load-bearing for modular characters.** `group_by` (on `group_id` then `z`),
`composite_emit`, `tint` and `select`. A character is three to six records that
must sort as one unit; the pair `(group_id, z)` is lexicographic, which is why
`group_by` takes two key lists rather than one. `tint` and `select` are what make
a per-part flash or fade possible without a second pipeline.

**Speculative, and honest about it.**

- `sin`, `cos`, `sqrt` (35, 36, 12) — no preset needs them. They are cheap in the
  lowering and expensive in review time; if the first preset set does not use
  them, cut them.
- `tuple`/`tuple_get` (16, 17) — a convenience for multi-value expressions. A
  graph can use `rect` and separate slots instead, at the cost of node count.
- `blend` beyond two modes (30) — the op is load-bearing; the mode table is not
  yet specified, and a mode table is precisely the enum §1 rule 1 warns about.
  It should be a small fixed set resolved at compile time, and the reviewer should
  confirm the set before it grows.
- `parallax_offset` (33) — load-bearing for layered backgrounds and speculative
  for everything else. It is also the only per-frame input in v1 (§11), so its
  exact semantics carry more weight than its size suggests.
- `const_i32`/`const_f32` (4, 5) — needed, but the float encoding is a wart
  (§12 item 7).
- **`neg` (10), `abs` (37), `min` (38), `max` (39) — the four weakest.** Each is
  expressible another way — `sub` from a zero constant for `neg`, a pair of
  `cmp_lt` + `select` for `abs` and for each of `min`/`max` — at the cost of
  nodes. If the reviewer cuts them, their ids **retire rather than get reused**:
  id reuse is the one change this format cannot absorb, because a cached
  pipeline outlives a rebuild (§6.3).

### 6.7 Vocabulary conformance

The gate before any adapter is scaffolded: does `tension-shadergen`'s seam accept
a second renderer's naming without changing the trait?

The crate claims the answer in its own module docs — "the OGRE-specific naming
lives in `tension-ogre`'s adapter" (`src/vocab.rs:1–14`) — but no adapter in the
tree implemented `Vocabulary`, so the claim had never been exercised from outside
the crate. `tension-shadergen/tests/vocabulary_sdl_gpu.rs` exercises it.

**The trait fits, unchanged.** Three tests, all passing:

- `classic2d_vertex_shader_uses_the_sdl_gpu_vocabulary` — the 16-byte quad layout,
  `SdlGpuVocabulary`, asserting one attribute at location 0, `vec4 a_position`,
  `gl_Position`, and that the neutral names do not leak.
- `every_spelled_differently_slot_reaches_the_shader` — a 28-byte sprite-shaped
  layout, asserting the two names SDL_GPU spells differently actually arrive:

  ```glsl
  layout(location = 0) in vec4 a_position;
  layout(location = 1) in vec2 a_uv0;
  layout(location = 2) in float a_colour;
  ```

- `the_trait_is_usable_as_a_shared_dyn_reference` — `&dyn Vocabulary` through two
  calls, same output, so the seam is object-safe and generation stays a pure
  function of (layout, vocabulary).

No method was added, no signature changed, and the vocabulary needed nothing from
the crate's internals. `attribute(&self, slot: Slot) -> &'static str` is enough
for SDL_GPU.

**But the spike found something else, and it is more important than the trait.**
The 16-byte `classic2d` layout — the crate's own unit-test fixture — generates a
degenerate vertex shader:

```glsl
layout(location = 0) in vec4 a_position;

void main() {
    vec4 position = vec4(0.0, 0.0, 0.0, 1.0);
    position.x = a_position.x;
    position.y = a_position.y;
    position.w = a_position.z;
    gl_Position = position;
}
```

With fields `(PosX, PosY, W, H)` in the `Position` slot, that shader sets
`gl_Position.w` to the sprite's **width** and drops `H` entirely — `Semantic::H`
has no entry in `position_axis()` (`src/lib.rs:39–50`), so it is silently
skipped. The GPU then divides x and y by the width. The crate's unit test passes
because it only asserts that `layout(location = 0)` and `gl_Position` appear.

This is not a `Vocabulary` defect; it is a defect in the vertex model behind it,
and it is exactly what a conformance spike is for. `generate_vertex` assumes a
homogeneous 3D vertex — four fields that *are* `(x, y, z, w)` — whereas a 2D
sprite quad is a base position plus a size, with the corner coming from
`gl_VertexIndex`:

```
px = base + corner * size
```

That model has no `w` to set, no perspective divide, and no field to drop. Until
the generator grows it, the graph compiler in §6.5 cannot lower a sprite stage,
because the stage's `emit_vertex` produces exactly this base-plus-corner shape.

**What this means for the scaffold, in order:**

1. The `Vocabulary` trait is validated. It ships as it is.
2. `generate_vertex`'s position model was not usable for 2D. **This is now fixed**
   — see §6.7.1. It was the true blocker the conformance gate surfaced.
3. The crate's test was rewritten to assert the arithmetic
   (`tension-shadergen/tests/classic2d.rs`) rather than the presence of
   `gl_Position`, so the next reader cannot inherit the same false confidence.

### 6.7.1 The corrected vertex stage

The generator now emits a sprite batcher, not a mesh transform:

```glsl
layout(std430, binding = 0) readonly buffer Records { uint r_words[]; };
layout(set = 1, binding = 0) uniform CanvasBlock { vec2 u_canvas_half; };

void main() {
    const uint kStride = 7u;
    const uint base = uint(gl_InstanceIndex) * kStride;
    const vec2 kCorners[6] = vec2[6](
        vec2(0.0, 0.0), vec2(1.0, 0.0), vec2(1.0, 1.0),
        vec2(0.0, 0.0), vec2(1.0, 1.0), vec2(0.0, 1.0));
    const vec2 corner = kCorners[gl_VertexIndex];

    float a_position_x = uintBitsToFloat(r_words[base + 0u]);
    float a_position_w = float((r_words[base + 3u] >> 0u) & 0xFFFFu);
    // … y, h and the src rect likewise …

    vec2 px = vec2(a_position_x + corner.x * a_position_w,
                   a_position_y + corner.y * a_position_h);
    vec2 clip = vec2(px.x / u_canvas_half.x - 1.0,
                     1.0 - px.y / u_canvas_half.y);
    gl_Position = vec4(clip, 0.0, 1.0);

    out_uv = vec2(a_uv0_x + corner.x * a_uv0_w,
                  a_uv0_y + corner.y * a_uv0_h);
}
```

Three consequences worth recording:

- **Records are read as whole `u32` words and shifted.** Not through a typed
  std430 struct: the record's source of truth is a schema table, its `u16`s are
  not 16-bit GLSL types without extensions, and word-shifting works identically
  under every driver. A `F32` at a non-word offset is therefore `-EINVAL`, which
  `validate()` now enforces.
- **Pixels become clip space through a uniform.** `u_canvas_half` at set 1,
  binding 0, pushed per draw with `SDL_PushGPUVertexUniformData`. The corner
  arithmetic is exactly `base + corner * size` as specified; only the final
  projection is the generator's addition. Without it a pixel-space record would
  be interpreted as clip coordinates and every sprite would land off-screen.
- **`Slot` became a naming group.** There are no vertex attributes any more, so
  `Vocabulary` names the *loaded values* (`a_position_x`, `a_uv0_w`, `a_colour`)
  rather than attribute declarations. The trait is unchanged; only what it is
  attached to moved.

### 6.8 Cache

`pipe_id` for a guest graph is a **hash of the blob bytes** — 64-bit, folded into
the 100–999 namespace by `100 + (hash % 900)`, with the full hash stored beside
the id and compared on lookup so a collision is a compile, not a wrong draw. The
namespace is small; a guest needing more than 900 distinct graphs is a guest whose
`pipe_id`s should have been the handle's problem, and §12 records that.

On first use of an id: validate (§6.9), lower, compile, upload. On every
subsequent use: look up. A pipeline is created once and reused per frame, and a
frame's cost is the draws, not the compilation.

`shader_compile_raw` ids are allocated from 1000 upward, sequentially — there is
no blob to hash.

### 6.9 Validation

The frontend runs before any lowering, and a failure is `-EINVAL` with a message
naming the node:

1. **Structure** — magic, version, lengths, table offsets inside the blob, no
   trailing bytes, reserved fields zero.
2. **Schema** — every field's `offset + width(dtype) <= record_size`; no two
   fields overlap; `record_size` is the stride `submit` will send (§3).
3. **Types** — every node's args match its signature, every slot is assigned
   before use and assigned once, every node's result is consumed or reaches the
   output.
4. **Bounds** — every `load_field`/`store_field` field index is in the schema;
   every `record_at` index is provably in range or guarded by a `select`.
5. **Termination** — the stage emits at least one vertex per record it is given,
   and its output slot is a terminator. A stage that drops records silently is
   the failure mode this check exists for.
6. **Completeness** — every field the vertex stage reads exists in the record the
   guest submits, which is why the schema is in the blob and not implied.

Refusal is `-EINVAL` for 1–6 and `-ENOSYS` for a well-formed graph using an opcode
or dtype this build cannot lower. The distinction matters: `-EINVAL` means the
graph is wrong, `-ENOSYS` means the host is old.

---

## 7. Rendering path

**SDL_GPU.** This host links SDL3 **3.4.18** (`pkg-config --modversion sdl3`), and
every symbol this design names exists in it — verified with `nm -D` against
`/usr/lib/libSDL3.so.0`: `SDL_CreateGPUGraphicsPipeline`, `SDL_CreateGPUBuffer`,
`SDL_BindGPUVertexStorageBuffers`, `SDL_DrawGPUPrimitives`,
`SDL_SubmitGPUCommandBuffer`, `SDL_WaitForGPUIdle`,
`SDL_DownloadFromGPUTexture`, `SDL_MapGPUTransferBuffer` (103 `SDL_*GPU*` symbols
in total). SDL_gpu.h is 182 900 bytes at `/usr/include/SDL3/SDL_gpu.h`.

Per stage, per bucket:

- **One storage buffer.** Sized to `submit`'s declared max records for that
  bucket, so a bucket never reallocates mid-frame. `SDL_CreateGPUBuffer` with
  `SDL_GPU_BUFFERUSAGE_GRAPHICS_STORAGE_READ`, bound with
  `SDL_BindGPUVertexStorageBuffers` (`SDL_gpu.h:3462`).
- **One graphics pipeline**, created at `set_pipeline` from the graph's generated
  shaders and vertex layout, never per frame.
- **One draw**: `SDL_DrawGPUPrimitives(pass, 6, N, 0, 0)` — six indices per quad,
  N instances. A 10k-sprite bucket is one draw call.
- **No CPU expansion.** The vertex shader reads the record from the storage
  buffer at `gl_InstanceIndex` and computes the corner from `gl_VertexIndex / 6`.

The instance-in-shader pattern is Moonside Games' sprite batcher, whose write-up
is the reason a sprite batcher can be one draw with no vertex buffer at all: the
per-instance data is the sprite, and the shader synthesizes the quad. The pattern
is what makes §6.4's "record in, vertices out" graph shape cheaper than expansion:
there is nothing to expand.

**Multi-atlas.** A pipeline samples a 16-layer `SDL_GPUTexture` array
(`SDL_GPU_TEXTURETYPE_2D_ARRAY`) rather than a single 2D texture: one layer per
atlas page, each page copied in by `set_texture` with
`SDL_CopyGPUTextureToTexture` (a GPU-side copy — the pixels never come back to the
CPU). The vertex stage writes the record's `tex` as a `flat` varying and the
fragment stage samples `vec3(uv, page)`. The alternative — one texture bound per
draw and the bucket split by page — was rejected because splitting a bucket
reorders its draws, and draw order inside a bucket *is* the graph's sort.

The uniform block and the sampler binding therefore move with the span, not once
per frame: two pipelines in one frame may have atlases of different sizes.

**The measured figure.** The first draft of this section quoted **~0.06 ms at
1k–10k sprites** from a planning probe that left nothing in the tree. That number
is now replaced by a probe that does: `tension-2d/bench/sprite_batch.c`, built and
run by `scripts/bench-sprite-batch.mjs`, recorded in
`tension-2d/bench/results.txt`.

The probe builds exactly the path this section specifies — 28-byte records
uploaded each frame through a transfer buffer, one storage buffer, one
`SDL_DrawGPUPrimitives(6, N, 0, 0)` — and reports two numbers. `cpu_ms` is frame
start to submit-return (the batcher's CPU cost). `net_cpu_ms` subtracts a
measured empty-frame baseline, so it is the marginal cost of the bucket rather
than the fixed cost of any frame.

On this host (WSL2, SDL 3.4.18, the only Vulkan ICD is `dzn`):

| N | cpu_ms | net_cpu_ms | total_ms |
| --- | --- | --- | --- |
| 1024 | 0.447 | 0.208 | 0.953 |
| 10 000 | 0.479 | 0.240 | 1.021 |
| 50 000 | 0.686 | 0.447 | 1.335 |
| 100 000 | 1.010 | 0.771 | 1.810 |

Empty-frame baseline: 0.239 ms cpu, 0.713 ms total. Median of 31 frames after 10
warm-up frames. One run is recorded in `results.txt`; the probe was run five more
times and `net_cpu_ms` at 1k–10k ranged **0.098–0.252 ms**, so the spread is as
large as the effect and a single run should not be read to three digits.

**The old figure did not reproduce, and the difference matters.** Measured net
cost at 1k–10k is **0.10–0.25 ms** across six runs, against a reported 0.06 ms —
so the true figure is roughly two to four times the one the first draft quoted,
and the `results.txt` run (0.21–0.24 ms) sits at the slow end of that spread. The
marginal cost per sprite is about **6–9 ns**, so the 1k number is almost entirely
the fixed cost of encoding one draw — a copy pass, a render pass, a pipeline bind
and a storage-buffer bind — not the per-sprite work. That inverts the design
assumption: the thing to watch is the number of buckets, not the number of
sprites in them. A frame with 100 buckets of 100 sprites would cost far more than
one bucket of 10 000.

**What this host cannot tell anyone.** The only Vulkan ICD present is `dzn` (a
WSL path over Microsoft's Basic Render Driver), so `total_ms` is a fill-rate
measurement of the host CPU and says nothing about a GPU. `cpu_ms` is CPU-side
and transferable in shape, but it includes this driver's command encoding, which
a hardware driver would price differently — likely lower, but not free. The
budget should be re-measured on a machine with a real GPU before it is written
down anywhere else.

**Headless.** An offscreen render target and `SDL_DownloadFromGPUTexture` for
pixel assertions. SDL_gpu.h's own opening says the API "can render offscreen
entirely, perhaps for image processing, and not use a window at all"
(`SDL_gpu.h:35`). §9 has the driver detail.

**Alpha blending, and the test that found it missing.** The pipeline's colour
target is created with source-over blending on straight (non-premultiplied)
alpha — `SRC_ALPHA` / `ONE_MINUS_SRC_ALPHA` for colour, `ONE` /
`ONE_MINUS_SRC_ALPHA` for alpha. Until the isometric example existed this was
`enable_blend = false`, i.e. SDL_GPU's default, and every test passed: a sprite
batcher whose sprites are opaque rectangles cannot tell the difference. A
cut-out sprite cannot. The first isometric frame drew the conifer's transparent
margins as opaque black rectangles the size of each src rect, and the character's
top layer erased the two beneath it — a transparent texel writes its colour when
nothing blends. That is a one-line defect with a whole class of symptom, and it
is the argument for having a worked example at all: the suites were green while
the renderer could not draw a tree.

The blend is on the *pipeline*, so every preset and every compiled graph gets
it. The hexdump assertions of the earlier suites are unchanged, because
blending an opaque texel is the identity.

**The tradeoff, stated rather than hidden.** SDL_GPU uploads through a transfer
buffer: map, write, unmap, then `SDL_UploadToGPUBuffer` — a copy pass
(`SDL_gpu.h:331–335`). Vulkan and D3D11 can map a vertex buffer and write it
directly, one copy less. The cost is one memcpy per bucket per frame, and the
arithmetic is unflattering but small: 28 bytes × 10 000 records = 280 KiB per
bucket per frame, ~17 MB/s at 60 Hz; at 50 000 records, 1.4 MB and ~84 MB/s.
That is inside any PCIe or unified-memory budget by orders of magnitude, and it
is still one copy that a direct-mapped design would not pay. At the point where
this matters, the answer is double-buffered storage buffers and a
`SDL_GPUBufferUsage` rework, not a different API.

---

## 8. Textures

**ImageViewer is the only decoder.** It is **Apache-2.0** — not MIT — and solely
authored by Yabgu. (The first draft of this section said MIT; the repository's
`LICENSE` and `README.md:110` both say Apache-2.0, and that correction is carried
into §10.) Apache-2.0 is permissive and fine here; what it adds over MIT is a
patent grant and a NOTICE obligation, and the 2D adapter is not yet referencing
the project at all (§13), so there is nothing to notice today.

The descriptor pattern this document uses for the record schema is
ImageViewer's, read from `src/imageviewer/ImagePluginDef.h` on
`github.com/Yabgu/ImageViewer` at the time of writing. What it actually contains:

- `IWImageFormat` — `{componentCount, bitsPerPixel, storageLayout,
  components[8]}` where each `IWComponentDef` is
  `{semantic, componentClass, bitOffset, bitWidth}`. Semantics are R/G/B/A, H/S/L,
  GRAY, UNKNOWN, with 0 reserved as "unused slot"; classes are UINT/SINT/UNORM/
  SNORM/FLOAT. Layouts are INTERLEAVED and PLANAR.
- `ImagePluginData` — `{width, height, stride, colorSpace, size, data, format}`,
  the decoded raster plus its description.
- The plugin exports `LoadImageFromFile`, `FreeImageData`,
  `ImagePluginGetLastError`, and optionally `LoadImagePreviewFromFile`.

The pattern is the point: **a per-component descriptor with a reserved zero**, so
an unset slot is detectable without asking how many components there are, and a
mixed-precision non-RGB image needs no new enumerator. §6.2's record tables are
the same shape for the same reason.

**`iwconv` is real, bidirectional, and is the pack-time encoder.** It lives at
`src/tools/iwconv.cpp` and takes two paths:

```
iwconv <in.png> <out.iwi>    # Image::FromFile -> iw::BuildImage -> iw::SaveIWI
iwconv <in.iwi> <out.png>    # iw::LoadIWI -> WritePNG
```

So the pack-time encoder is not missing work — it is a thin caller over two
pieces that already exist: `IWImageIO.ixx`'s writer (`SaveIWI` /
`SerializeImage`) and ImageViewer's `Image` decoder. An earlier revision of this
document said `iwconv` was one-way (IWI → PNG); that was wrong, and the PNG → IWI
direction is the one that matters here.

What is still tension-side work is the **atlas**: a single IW blob per atlas page
plus the frame table and anchor table the graph reads (`atlas_frame`,
`anchor_from_atlas`, §6.3). `iwconv` converts one image; it does not pack a
sprite sheet or emit metadata. That is a small tool of ours, not an ImageViewer
change.

The IWI format itself is small and worth recording because the adapter decodes it:
magic `IWI1`, then 74 bytes of header (width, height, colour space,
`componentCount`, `bitsPerPixel`, `storageLayout`, eight 6-byte component
descriptors, pixel byte count), then the pixels. All little-endian.

**At runtime, `texture_load` accepts IW, PNG and JPEG** and produces the
`target_format` the guest asked for. One decoder in the tree means one set of
format bugs, one colour-space policy, and one place a CVE is reported.

**Resolved: `iw_decode_to_format` does not exist, and the fix belongs in
ImageViewer.** The settled design said ImageViewer "produces `target_format`". It
does not. What it actually exposes, read from a clone of
`github.com/Yabgu/ImageViewer` at `eb7e9eb`:

- Decoders are **separate plugin DSOs** (`libImageLoaderJpeg.so`, …), loaded at
  runtime by `PluginManager` through `dlopen`/`LoadLibrary` and resolved by
  symbol name.
- The plugin ABI is `LoadImageFromFile(path) -> ImagePluginResult {
  ImagePluginResultCode code; ImagePluginData *data; }`, plus `FreeImageData`,
  `ImagePluginGetLastError`, and an optional `LoadImagePreviewFromFile`.
- `ImagePluginData` is `{width, height, stride, colorSpace, size, data, format}`
  where `format` is the full `IWImageFormat` descriptor.

So a decode yields **pixels in whatever layout the decoder chose, described but
not converted**. There is no conversion entry point anywhere in the tree — not in
`ImagePluginDef.h`, not in `IWImageIO.ixx`, not in `iwconv`. The closest thing is
ImageViewer's own display path (`Window.ixx`, `TryUploadPackedSource`), which
uploads the source pixels directly when they are packed RGB8/RGBA8 and otherwise
"the caller converts" — an inline GL-shaped special case, not an API.

Two ways to close that gap, and this document picks **(b)**:

- **(a) The adapter converts after decode.** No ImageViewer change. The 2D
  adapter takes `IWImageFormat` + pixels and repacks to `SDL_GPUTextureFormat`
  itself: handle PLANAR by de-interleaving, non-8-bit components by narrowing,
  missing alpha by filling 255, CMYK by converting, sRGB by flagging. That is a
  colour-and-layout conversion library written twice — once here, once in any
  other consumer of ImageViewer — and the second copy will disagree with the
  first about premultiplication.
- **(b) ImageViewer gains `iw_decode_to_format`.** Yabgu owns both sides, so the
  conversion lives inside the decoder, where the layout knowledge already is.

The choice is **(b)**, for the reason (a) exists at all: the conversion is decoder
knowledge. A function that reads `IWImageFormat` and writes a requested one
belongs beside the code that produces `IWImageFormat`. Putting it in the adapter
would mean the 2D capability owns a piece of ImageViewer's contract, which is the
same boundary error §1's broker rule exists to prevent.

**The follow-up this needs, named so it is not forgotten:** an ImageViewer PR
adding the entry point below, or — if that is not feasible on ImageViewer's
schedule — a Tension-side fork, which is a decision for the user and not this
document. Until one of those lands, `texture_load`'s `target_format` argument has
no implementation and v1 is blocked on it.

The shape it needs, from the adapter's side:

```c
/* Decode encoded bytes (IW, PNG or JPEG) into exactly the requested layout.
 *
 * src/src_len      the encoded file image; format sniffed, not declared
 * target           the layout the caller wants; an IWImageFormat with
 *                  storageLayout INTERLEAVED and every component's bitOffset
 *                  fixed. Owned by the caller, read only.
 * target_space     the color space to convert to (SRGB or LINEAR)
 * premultiply      whether to premultiply RGB by A (the SDL_GPU blend path
 *                  wants it; a test asserting raw pixels does not)
 *
 * Returns a decoded ImagePluginData whose format matches target exactly, or a
 * non-OK ImagePluginResultCode with a message from ImagePluginGetLastError.
 * Released with FreeImageData, same as LoadImageFromFile.
 */
ImagePluginResult iw_decode_to_format(const uint8_t *src, size_t src_len,
                                      const IWImageFormat *target,
                                      ImageColorSpace target_space,
                                      bool premultiply);
```

Taking `IWImageFormat` as the target rather than a new SDL-shaped enum is the
point: it is the descriptor pattern §6.2 already borrows, it expresses packed and
planar, and it needs no enum that grows every time a driver offers a format. The
formats v1 actually needs are a short list, and the adapter maps them:

| target `IWImageFormat` | `SDL_GPUTextureFormat` |
| --- | --- |
| 4×8 UNORM R,G,B,A interleaved | `R8G8B8A8_UNORM` |
| 4×8 UNORM R,G,B,A, sRGB space | `R8G8B8A8_UNORM_SRGB` |
| 1×8 UNORM GRAY | `R8_UNORM` |
| 4×16 FLOAT R,G,B,A | `R16G16B16A16_FLOAT` |

Everything else (palettised PNG, 4-component CMYK JPEG, 16-bit grayscale) is the
decoder's problem to land in one of those four, and a source it cannot represent
is a named error rather than a silently truncated image.

**One more thing `iw_decode_to_format` does not solve:** the plugins are separate
DSOs, so consuming ImageViewer means either shipping them beside the adapter and
`dlopen`ing them, or linking a build that has decoders compiled in. That is a
packaging question for the scaffold, not a design question, but it is the reason
the dependency is "ImageViewer plus its plugins" and not just one library.

**OGRE is not linked by this adapter.** No OGRE header, no OGRE type, no
`DT_NEEDED` on OgreMain. The 2D adapter's dependencies are SDL3, SDL_shadercross,
ImageViewer and libc — the same discipline `tension-input` measures on its own DSO
(`tension-input/DESIGN.md` §6: "SDL is the only capability dependency, and the
host is not one").

## 8.1 Build prerequisites

Four of the 2D path's five dependencies are not in the tree, and one of them is
not on this machine at all. Naming that here rather than discovering it at
scaffold time is the point of this subsection.

| dependency | license | status | decision |
| --- | --- | --- | --- |
| SDL3 | Zlib | **present** — 3.4.18, `pkg-config sdl3` | system dependency, as `tension-input` already does |
| SDL_shadercross | Zlib | **absent** — no pkg-config, no `libSDL3_shadercross*` | **vendor** into `third_party/shadercross/` |
| Cranelift | Apache-2.0 + LLVM exception | transitive via Wasmtime 24.0.13 | already linked; the question is the API, not the dependency |
| ImageViewer | Apache-2.0 | **absent** — nothing in the tree references it | vendor a pinned copy after `iw_decode_to_format` lands |
| Naga | MIT OR Apache-2.0 | **linked** — 29.0.4, build and run time | the shader compiler; replaced glslangValidator. Pinned to 29.0.4 because 30.0.1's `glsl-in` feature does not compile (its `apply_default_interpolation` sits behind a `spv-in`/`wgsl-in` cfg gate) — retested 2026-11-06, see `tension-core/Cargo.toml` |
| glslang | BSD-3-Clause | present | used by the **bench** only; no longer in the adapter's build |

**SDL_shadercross — vendored, not system.** It is not installed here, and the
tree has a working precedent for the alternative: OGRE-Next is a submodule under
`third_party/ogre-next/`, configured and built by `scripts/bootstrap.mjs`, with
its patches kept in `third_party/patches/` (that is how the FreeImage codec guard
lands). Shadercross is small and Zlib-licensed, and vendoring it means the adapter
builds with no distro package that may not exist, at a version the tree pins
rather than whatever `pkg-config` finds.

What shadercross buys, stated precisely, because it is easy to over-buy it:
SDL_GPU needs `SDL_GPUShaderFormat` code per platform — SPIR-V on Vulkan,
DXBC/DXIL on D3D12, and MSL/metallib on Metal. Shadercross translates from one
authoring language to those. **On a Linux-only v1 it is not needed:** the probe in
§7 compiled both its shaders with `glslangValidator` straight to SPIR-V and SDL_GPU
consumed them, so glslang alone covers the Vulkan path. Shadercross earns its
place the moment the adapter has to run on Windows or Metal, and vendoring it now
rather than later is the cheaper of the two orderings — but the honest statement
is that v1 on Linux does not block on it.

**Cranelift — a dependency that is already linked, with an unverified API.**
`cranelift-codegen` and siblings are in `tension-core/Cargo.lock` (lines
319–414) as Wasmtime 24.0.13's compiler. Using them directly for §6.5's CPU
lowering means depending on a crate that is currently only transitive: the
version is pinned by Wasmtime, not by Tension, and whether the API surface
(`cranelift-jit`? `cranelift-codegen` + a manual `Module`?) is what this design
wants has not been checked. This is the one prerequisite where "it is already in
the tree" is weaker than it sounds.

**ImageViewer — vendored after its PR, not before.** The adapter would be its
first consumer anywhere in this tree (§13), and its decoders are separate plugin
DSOs, so the packaging unit is ImageViewer-plus-plugins. Vendoring now would pin
a version that lacks `iw_decode_to_format`; vendoring after that PR lands pins the
version v1 actually needs.

**glslang — build-time, already present.** The bench uses it and so could the
adapter's build. It is a host tool, not a linked dependency, which keeps it out
of the DSO's `DT_NEEDED` and out of §10's runtime license inventory.

---

## 9. Headless

`SDL_VIDEODRIVER=offscreen` plus an `SDL_GPU` offscreen texture. Verified in the
linked library: `offscreen` is a driver this build carries
(`strings /usr/lib/libSDL3.so.0` contains both `offscreen` and `dummy`, and
`SDL_HINT_VIDEO_OFFSCREEN_SAVE_FRAMES` exists at `SDL_hints.h:3911`), and the GPU
API does not require a window (`SDL_gpu.h:35`).

**The trap, carried from the earlier measurement, not re-measured here.** `dummy`
comes up as a video driver but has no GPU backend, so `SDL_CreateGPUDevice`
against it fails; `offscreen` does. A headless run that sets
`SDL_VIDEODRIVER=dummy` out of habit fails at `open` with `-ENODEV`, which is the
correct answer but a confusing one. The adapter should refuse `dummy` by name in
`open` and say why — that turns a two-hour debugging session into one log line.

This is the same class of finding as `tension-input`'s "a driver that cannot
deliver events still attaches" (`tension-input/DESIGN.md` §7): a driver name that
looks right and is not. That capability recorded the measurement instead of
picking a policy; this one picks — refuse `dummy`, name it, and accept `offscreen`
and any driver that reports a GPU device.

**Pixel readback** is `SDL_DownloadFromGPUTexture` into RGBA8, normalized to one
guest format regardless of what the driver chose internally. The guest's
screenshot is always `width × height × 4` bytes, top-left origin, RGBA8,
non-premultiplied — one format, so a test asserts pixels rather than driver
behaviour. `screenshot` returns it (§3, verb 9).

No Xvfb and no software GL are needed, which matters more than the pixel format:
a CI job that needs a display server is a CI job that flakes.

---

## 10. License posture

Everything in the 2D path is permissive, and the two removals this arc made are
what keeps it that way.

| component | license | status |
| --- | --- | --- |
| Tension | MIT | in tree |
| SDL3 | Zlib | linked (`pkg-config sdl3` 3.4.18) for `tension-input`; the 2D adapter adds it |
| SDL_shadercross | Zlib | **not present on this host**; vendored per §8.1 |
| ImageViewer | **Apache-2.0**, sole-authored by Yabgu | **not yet referenced anywhere in the tree** (§13) |
| glslang | BSD-3-Clause | build-time only, present; not linked into the DSO |
| TensionScript | MIT | in tree |
| Cranelift | Apache-2.0 with LLVM exception | already transitive via Wasmtime 24.0.13 (`Cargo.lock:319–414, 2014`) |
| AsmJit | Zlib | not in the tree; available if the CPU lowering ever needs hand-written JIT |
| FreeImage | FIPL (and the reason for the guard patch) | **removed** |

**FreeImage is gone, and the removal is committed.** `packages/freeimage` is
deleted, `.gitmodules` no longer lists it, `packages/ogre/package.json` no longer
depends on the deleted package, and `tension-ogre/CMakeLists.txt`'s `INSTALL_RPATH`
no longer names a freeimage `lib`. What remains is the build guard, by design:
`scripts/bootstrap.mjs:100–159` patches `OgreFreeImageCodec2.cpp` behind
`#if !OGRE_NO_FREEIMAGE`, carries
`third_party/patches/ogre-no-freeimage-codec.patch`, and configures with
`-DOGRE_CONFIG_ENABLE_FREEIMAGE=OFF`.

**One incompleteness, flagged:** six example lockfiles still resolve
`@yabgu_gm/tension-freeimage` —
`examples/ogre/{animated-character,bouncing-ball,bouncing-bodies,hello-mesh,hello-triangle,input-camera}/package-lock.json`.
They are regenerable (`npm install`) and reference a package that no longer
exists, so a clean install would fail on them. They are not in the 2D path, but a
license audit that greps the tree will find them, and it should not.

Two corrections entered this table from the §8 read rather than from assumption.
**ImageViewer is Apache-2.0, not MIT** — `LICENSE` and `README.md:110` agree —
which adds a patent grant and a NOTICE obligation over MIT and changes nothing
about whether it can be used. **glslang is in the 2D build path** as a host tool
(§8.1), so it is listed even though it never reaches the DSO's `DT_NEEDED`.

**No GPL or LGPL anywhere in the 2D path.** OGRE-Next is not in the path and not
linked (§8). STBI is off — the tree decodes through ImageViewer, and the
`STBI`/`stb_image` dependency that a sprite engine usually drags in is not present.
If a reviewer adds one, this section is where it must be argued.

---

## 11. What v1 does not do

- **No 3D.** The record schema is 2D; a `PosZ` semantic exists because the ABI
  descriptor has one (`tension_adapter.h:119`), not because a v1 pipeline uses it.
- **No skeletal 2D.** Spine-style animation needs bone matrices and a per-vertex
  influence; that is a `submit_bones` verb and a record field, and it is v1.5.
  The graph can already express the *ordering*; what it cannot express is the
  deformation.
- **No per-frame uniforms beyond `parallax_offset`.** A general `submit_uniforms`
  verb is v1.5. This is a real limit: any effect that needs a per-frame scalar
  that is not a camera-derived parallax offset is out of reach until then, and a
  guest will hit it. The mitigation is that `parallax_offset` covers the common
  case (layered backgrounds) and a graph can fold constants at compile time.
- **No C-ABI plugin vtable for alternative backends.** The internal seam is the
  Rust `ShaderGenerator` trait; `tension_2d_backend_vtable` is v1.5. A second
  backend is currently a recompile, not a DSO.
- **No Android.** SDL_GPU's Android story is not mature enough to design against;
  the offscreen headless path (§9) is not a substitute for a real surface.
- **No `tension-2d/` source files.** This document is the deliverable.

---

## 12. Open questions

Each is a question the tree does not answer, with the position this document would
argue and the reason it is not closed here.

1. **Is `set_pipeline` per-canvas or per-handle?** Per-handle is simpler and is
   what §3 assumes: one pipeline table, ids stable for the session. Per-canvas
   would let two canvases in one process use different pipeline tables, which only
   matters if a handle ever presents to more than one surface. `open` is capacity
   1, so today the question is unobservable — which is the argument for deciding
   it now rather than when it becomes observable.

2. **Is `shader_compile_raw`'s `pipe_id` scoped per-canvas or global?** §3 makes
   it global (ids ≥ 1000 in one table for the handle). Scoped would require the
   id to carry the canvas, and an id that carries a canvas is a handle with extra
   steps.

3. **Binary blob or JSON?** **Preference: binary.** A `pipe_id` is a hash of the
   bytes, so the format must be canonical; canonical JSON is a class of bug
   (key order, number formatting, whitespace, float round-trip) that canonical
   binary does not have, and hashing is what the cache is built on. The graph is
   machine-produced by a compiler, not hand-authored, so human readability buys
   less than it would for a config file. The debugging cost is real, and the
   answer is a JSON *dump* produced from a validated binary blob
   (`tension-2d graph dump`), not a JSON wire. If a reviewer disagrees, the
   disagreement is about who authors graphs, and that is the question to settle
   first.

4. **Namespace: `tension::2d` or `2d`?** `tension-ogre` uses the bare `ogre`
   because `tension::` is reserved for Tension's own built-ins —
   "`tension::io`, `tension::audio`, `tension::ai`, `tension::res` and
   `tension::solver` are Tension's own; the `tension::` prefix is reserved for
   them" (`tension-ogre/DESIGN.md` §2). 2D is Tension's own — it ships in the tree
   and is not a third-party capability — so `tension::2d` is the consistent
   choice and the bare `2d` would be the anomaly. This document uses
   `tension::2d`.

5. **The `u32` at offset 18 — resolved: padded to 28.** The first draft shipped a
   26-byte packed record, which put `sort_key` at 18, forbade a std430 struct in
   the lowering and forced byte-offset indexing by hand. §5 now pads two bytes and
   moves `sort_key` to 20: the record is 28 bytes, naturally aligned throughout,
   and the generated shader can use std430 directly. The alternatives considered
   and rejected were a 26-byte record with `sort_key` before `src_x` (same size,
   different field order — still 26, still not a multiple of 4) and dropping the
   `u16` `tex` for a `u8` (a smaller record that caps atlas pages at 256 for a
   saving of 2 bytes). Cost of the decision: 7% more upload bandwidth, which §7
   measures at about 17 MB/s at 10k sprites per bucket per frame at 60 Hz.

6. **Is the 28-byte record's `x`/`y` enough?** Integer pixels mean no sub-pixel
   positioning. A fixed-point variant is a schema change. Most 2D engines need
   sub-pixel for smooth camera motion; the graph can accumulate a fraction if the
   record grows a field, and that is the v1.1 question.

7. **`const_f32`'s literal encoding** (§6.3 note): a per-stage constant pool, or a
   wider node record. The pool is cheap and slightly awkward; the wider node costs
   4 bytes per node for every graph.

8. **What happens when the pipeline table fills at 900?** §6.8 assumes a guest
   does not; `-ENOSPC` is the documented answer. If a real guest hits it, the
   namespace split (100–999) is the thing to revisit, not the cache.

---

## 13. What this document could not verify

Rule 8 and rule 9 of the handover, applied to a document rather than a landing.

**Verified from the tree or the machine, and cited above:**
ABI version 4 and the 18-slot table with `shader_generate` last
(`tension_adapter.h:17–23, 80, 434, 648–665`); `TENSION_ADAPTER_LAYOUT_HASH` =
786288195u and what it does and does not cover (`:100`); the descriptor codes
(`:117–144`, `:423`); the closed errno list (`:530–540`) and the `-ENODEV` deviation with
its precedent (`tension_input.h:222–238`); the vtable shape with `publish`/`apply`
NULL (`tension-input/src/adapter.cpp:328–341`); the nine-preset limit and
`-ENOSYS` discipline (`tension-shadergen/src/lib.rs:175, 286, 374`); the registry's
`OnceLock` and its `-ENOSYS` (`tension-core/src/shadergen_registry.rs`); `init`
registering the default generator (`tension-core/src/lib.rs:27–31`); Cranelift and
Wasmtime in `Cargo.lock`; SDL3 3.4.18 with every GPU symbol this design names
(`nm -D`, `pkg-config`); `offscreen` and `dummy` as driver names in the linked
library; the FreeImage removal's completeness aside from the six lockfiles.

**Measured since the first draft, so no longer open:**

- **The sprite-batch cost.** `tension-2d/bench/results.txt` now carries a real
  measurement from `sprite_batch.c`: 0.10–0.25 ms net CPU per bucket at 1k–10k
  sprites, ~6–9 ns per sprite marginal, drawn and read back (nonblack pixels
  asserted). The old 0.06 ms figure did not reproduce. §7 has the table and the
  caveat that the host's only Vulkan ICD is software.
- **`iw_decode_to_format`.** Confirmed absent by cloning ImageViewer at `eb7e9eb`
  and reading the source: the decode API is `LoadImageFromFile` returning an
  `IWImageFormat` *description*, and no conversion entry point exists anywhere.
  §8 records the finding, the choice (add it to ImageViewer), and the signature
  it needs. It is unresolved *work*, not an unresolved *question*.
- **`iwconv`.** It exists — `src/tools/iwconv.cpp` in ImageViewer — and is
  bidirectional: `.png → .iwi` through `Image::FromFile` + `iw::SaveIWI`, and
  `.iwi → .png` through `iw::LoadIWI`. It *is* the pack-time encoder's conversion
  step; what it does not do is pack an atlas or emit frame/anchor metadata (§8).
- **ImageViewer's license.** Apache-2.0, not MIT (§10).
- **`Vocabulary` conformance.** Exercised from outside the crate
  (`tension-shadergen/tests/vocabulary_sdl_gpu.rs`, 3 tests passing). The trait
  fits unchanged. The same spike found that `generate_vertex`'s position model
  could not express a 2D quad; that is fixed (§6.7.1) and covered by
  `tension-shadergen/tests/classic2d.rs`, which asserts the arithmetic and
  compiles both stages.
- **The FreeImage removal is committed**, not pending: `2c94afe`.

**Not verified, and named so nobody plans on it:**

- **`dummy` has no GPU backend; `offscreen` does.** Carried from the earlier arc;
  not re-measured here. The driver names are verified present, and the probe ran
  under `offscreen` and produced pixels — which confirms `offscreen` works and
  says nothing about `dummy`.
- **The bench numbers on real hardware.** This host's only Vulkan ICD is `dzn`
  over WSL2's Basic Render Driver. `total_ms` is a software fill-rate figure.
- **SDL_shadercross.** Not installed on this host (§8.1). The GLSL → SPIR-V path
  the bench used is `glslangValidator`, not shadercross.
- **ImageViewer as a dependency.** No file in the tree references ImageViewer, IW,
  or `iw_*` (§8, §10). The 2D adapter would be its first consumer, and "it is in
  the tree" is currently false.
- **Cranelift as a *code generator* — now measured.** It was in the tree only as
  Wasmtime's compiler; §14's comparator compilation proves `cranelift-codegen`,
  `-frontend` and `-native` at 0.111.13 are directly usable, so no `libc`-free JIT
  crate was needed.
- **The Moonside sprite-batcher write-up.** The pattern is described from the
  design discussion; the source is external and not fetched here.
- **The graph compiler (§6) is built for one shape.** Parse, validate, a
  Cranelift comparator and a GLSL lowering all exist and are tested (§14.1), but
  only for a stage that ends in `emit_quad` over a flat record. The opcode set is
  five primitives, not the ~30 §6.3 proposes; there is no cache keyed by graph
  hash at run time, and no `list`/permutation lowering beyond the sort.
- **A swapchain.** v1 renders to an offscreen target and reads it back with
  `screenshot`. There is no window path, so `present` is not a present in the
  SDL sense yet.
- **Multi-atlas — settled after the first draft.** The adapter now binds a
  16-layer texture array per pipeline (`set_texture`), and the shader samples it
  at the record's `tex`. The remaining limit is size: every page of one pipeline
  shares the array's dimensions, so two page sizes mean two pipelines. See §14.1.
- **`shader_compile_raw`.** The wire has the door; the build has no GLSL →
  SPIR-V translator linked into the DSO, so the verb answers `-ENOSYS`.
- **The tileset the isometric example uses is not in the tree.** It is a third-party tileset, fetched by `tension-2d/test-assets/fetch.sh` from the asset
  host; `tension-2d/test-assets/` is gitignored and only the fetcher travels.
  Every claim about it is reproducible by running that script, and unreproducible
  from a clone alone. That is the price of not vendoring third-party art.
- **Anything on a real GPU.** Every measurement and every pixel above was
  produced on this host's `dzn` ICD — a software Vulkan path. The pipeline runs;
  no performance claim here is a hardware claim.

**Two tree-versus-architecture contradictions, flagged in place, plus one
resolved:**

1. **`tension-shadergen`'s stated division of labour had no renderer-side half.**
   Its module doc says the OGRE-specific naming "lives in `tension-ogre`'s
   adapter" (`tension-shadergen/src/vocab.rs:1–14`), and no adapter in the tree
   implements `Vocabulary`. The conformance spike (§6.7) is now the first
   implementation from outside the crate, so the seam has one witness — for
   SDL_GPU, not for OGRE, which still has none.

2. **The FreeImage removal is complete in the code and incomplete in the
   lockfiles.** Six `examples/ogre/*/package-lock.json` still resolve
   `@yabgu_gm/tension-freeimage`, a package that no longer exists. §10 records it.

**Resolved since the first draft:** `generate_vertex` could not express a 2D
sprite quad — its position model was homogeneous 3D, and the crate's own 16-byte
fixture generated `gl_Position.w = a_position.z` (the sprite's width) while
dropping `H` entirely. It now emits a sprite batcher (§6.7.1), and
`tension-shadergen/tests/classic2d.rs` asserts the arithmetic term by term and
compiles both stages with `glslangValidator`.

---

## 14. Proven, and not proven

The honest state of the tree, after the dynamic-canvas/animation/multi-atlas
slice. Every line under **proven**
names the test that proves it; every line under **not proven** names what is
missing and why. A reader deciding whether to trust this design should read this
section before any other.

### 14.1 Proven

| claim | the test that proves it |
| --- | --- |
| **The renderer draws.** Ten sprites at recorded positions, 10240 non-black pixels = 10 × 32 × 32, each centre its own atlas colour. | `smoke_core.cpp` scenario A |
| **The sort works.** Reverse-`sort_key` submission is byte-identical to forward submission, over overlapping sprites so draw order is observable. | `smoke_core.cpp` scenario B and its reversed twin |
| **The compiler reproduces the preset.** `default_2d` parsed from a 584-byte blob renders byte-identically to the hand-written preset — and the build refuses if their SPIR-V differs. | `graph vs preset, scenario A/B: byte-identical`; `build-2d.mjs` SPIR-V comparison |
| **The compiler is general.** `default_2d_scaled` (653 bytes) renders at 2× via the graph's `const_f32` + `mul`, which `tension-shadergen` cannot express; coverage is exactly 4× and the sort still holds on top of it. | `smoke_core.cpp` scaled A / scaled B reversed; `default_2d_scaled SPIR-V differs from the preset, as it must` |
| **Composite grouping works.** Two characters on one tile, three layers each: pixel (20,20) is **cyan** (C2's last layer), not blue (C1's `z=2` backpack). The interleaved and grouped submissions are byte-identical. | `smoke_core.cpp` composite section. Revert-tested: swapping `group_id` and `z` in the graph turns the pixel blue, exactly the z-first prediction. |
| **The canvas size is the caller's.** A second handle opened at 320×180 reports that size from `info`, reads back `320 × 180 × 4` bytes, and puts its sprites where a 320×180 projection says. Opening at 0, at 16385, or with a non-zero flag is `-EINVAL`. | `smoke_core.cpp` 320×180 section. Revert-tested: hard-coding 640×360 in `open` makes `info` report the wrong canvas and the readback `-ENOSPC`. |
| **Animation.** One record, four submits, only `src_x` changing: pixel (16,16) is red, green, blue, yellow in turn, and (0,0) stays black. | `smoke_core.cpp` animation section. Revert-tested with `TENSION_2D_FREEZE_FRAME=1`: the frame index frozen at 0 leaves red at every step and the run exits 1. |
| **Multi-atlas.** Two atlases, same geometry, disjoint palettes; page 0 renders red and page 1 orange in the same draw. A page of another size, page 16 and an unknown pipe are each refused. | `smoke_core.cpp` multi-atlas section. Revert-tested: emitting `out_tex = 0u` in the vertex stage makes both sprites sample page 0 and both checks fail. |
| **Composite ordering across pages.** Two characters on one tile, one on each atlas page: pixel (20,20) is the page-1 character's colour (group 2), and reversed submission is byte-identical. | `smoke_core.cpp` multi-atlas composite section |
| **The three original problems compose on real art.** A 2816x5072 tileset (15 pages of 1024x1024) is paged into the adapter's 16-slot array; a conifer is sliced into crown (sort 86) and trunk (118) with the character (88) between them; a three-layer character composites by `group_id` 200 and `z`; a lantern sorts in front of the character. Six pixel probes, three pages in one draw. | `examples/2d/isometric/test.mjs`. Revert-tested twice: flipping the body/backpack `z` moves the probe from the backpack's colour to the body's, and dropping the lantern's sort key below the character's moves the lantern's probe to the character's own colour. Both mistakes are caught by the specific colour they produce, not by "something differs". |
| **The Cranelift comparator is correct.** A 45-record sample matches a plain-Rust reference over every ordered pair. | `pipeline::cranelift_backend::compiled_matches_reference` |
| **The generated shaders compile.** Both stages of both graphs parse, validate and emit SPIR-V through Naga. | `tension-shadergen/tests/naga_compile.rs` (5 tests); `classic2d.rs` (glslang, kept as a second opinion) |
| **The blob parser refuses malformed input.** Bad magic, short reads, a future version, over-long TLVs and truncation are each a refusal, not a panic. | `pipeline::parser::tests` |
| **The validator refuses bad graphs.** Dangling inputs, out-of-range field indices, cycles, unknown primitives, a missing emitter. | `pipeline::validate::tests` |

Three of those assertions were revert-tested rather than taken on faith: the
quad arithmetic (doubling it in the generator changes the pixel count), the sort
(disabling it fails at the first overlap), and the composite ordering (swapping
the keys turns cyan to blue).

### 14.2 Not proven

| gap | what is actually true |
| --- | --- |
| **Runtime compiler — built, narrowly.** | `set_pipeline` compiles an unknown blob through the host's ABI v5 `compile_graph` slot. Proven for one shape: a stage ending in `emit_quad`. The blob is compiled once and cached by hash (36 ms cold, 0.004 ms cached). Not proven: any graph shape the GLSL backend does not already know. |
| **`shader_compile_raw`.** | `-ENOSYS`. The DSO has no GLSL → SPIR-V translator of its own; the compiler lives in the host behind `compile_graph`, which takes a *graph*, not two shader sources. |
| **Isometric depth.** | `sort_key`-based ordering works, but no test populates `sort_key` from atlas anchor metadata — nothing computes an anchor yet. That is the framework layer's job, not the adapter's. |
| **Oversized tilesets.** | Multi-atlas exists (16 pages per pipeline), but nothing computes `tex` per tile yet. That is the framework layer's job; the adapter has no tile logic and should not grow any. |
| **Alpha blending on a hardware driver.** | Blending is enabled and proved correct on the `dzn` software ICD by the isometric example's cut-outs. It has not been exercised on a hardware Vulkan driver, nor are premultiplied pages supported (a page with premultiplied colours would double-darken its edges; the decoders here produce straight alpha). |
| **Mixed atlas sizes.** | Every page of one pipeline shares the array's dimensions, because an array texture has one size. A game with a 256×256 page and a 512×512 page needs two pipelines. Untested beyond the refusal. |
| **Complex sort keys.** | `mul` inside a sort key is unit-tested (`a_scaled_key_multiplies_before_comparing`) but no shipped pipeline uses one. The CPU path's `scale` column is exercised by tests only. |
| **Swapchain.** | Offscreen render target + `SDL_DownloadFromGPUTexture` only. On-screen presentation is untested; `present` is not a present in the SDL sense. A headless-CI concern, but "renders" here means "renders to a texture". |
| **Hardware performance.** | Every measurement is from the `dzn` software ICD (§7). The pipeline runs; no timing figure is a GPU figure. |
| **Windows / macOS.** | Untested throughout. `-G` vs `-V` (§8.1) suggests the shader path needs revisiting there. |
| **Texture decoding beyond IWI.** | PNG and JPEG are `-ENOSYS` until ImageViewer gains `iw_decode_to_format` (§8). |

### 14.3 What is in the tree

| file | what it is |
| --- | --- |
| `include/tension_2d.h` | the wire: ten verbs, the 28-byte `sprite` record, the submit header, the info record, the pipe_id ranges. No SDL include. |
| `src/adapter.cpp` | the edge: vtable, ten shims, registration. No SDL. |
| `src/render.h` / `src/render.cpp` | the device: SDL_GPU, storage buffer, pipeline table, texture table, per-pipeline texture arrays, graph-driven comparator, draw, readback. |
| `src/texture.h` / `src/texture.cpp` | the IWI reader (SDL-free), pending `iw_decode_to_format`. |
| `tests/smoke_core.cpp` | a stub `tension-core`: guest memory, `register_import`, then the verbs through the registered table. |
| `tests/*.t2dg` | the two graph blobs, written by `graph emit-default` on every build so they cannot go stale. |
| `scripts/build-2d.mjs` | generate GLSL → Naga → embed → link the DSO. |
| `scripts/test-2d.mjs` | build, then run the stub core headless and read the pixels. |
| `bench/` | the cost probe from §7, separate from the adapter. |
| `tension-core/src/pipeline/` | the compiler: parser, validator, Cranelift backend, GLSL backend. |
| `tension-core/src/pipeline_default.rs` | `default_2d` and `default_2d_scaled` as graphs, and the writer. |

**The vtable** is `tension-input`'s field for field: `abi_version` from the
constant (never a literal), `publish` and `apply` both NULL, `layout_hash` from
`TENSION_ADAPTER_LAYOUT_HASH`, nine imports registered in `link`.

**Two things the build found that the design had assumed otherwise:**

1. `glslangValidator -G` cannot compile this shader — not a version to bump.
   `-G` rejects the Vulkan builtin spellings and `layout(set = N)`, and SDL_GPU
   requires `set = 2` for its fragment sampler, so a `-G`-compatible shader
   cannot sample a texture at all. `-V` is the gate (§8.1).
2. The descriptor could not name the record's `x`/`y`. They are signed pixels,
   and `TENSION_DTYPE_*` stopped at `F32/U16/I16/U8`; `F32` would reinterpret
   the bits and `I16` caps a position at 32767 px. `TENSION_DTYPE_I32 = 5u` was
   appended to `tension_adapter.h` under the same append-only rule the semantics
   follow.

*The next step is the framework layer in TensionScript — anchor metadata into
`sort_key`, tiles into `tex` — and the multi-atlas work that `tex` was put in the
record for.*
