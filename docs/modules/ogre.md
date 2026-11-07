# tension-ogre — the OGRE capability

`tension-ogre` is the shared object that puts Ogre-Next behind the wasm import
module `ogre`. It owns the renderer, the render thread, the job table and the
scene mirror; it owns no window, no Vulkan instance and no surface of its own
when the host has one. This page states what the module is, what it refuses, and
which of its three descriptions — this page, the header, and the 3,240-line
`tension-ogre/DESIGN.md` it replaces — the code agrees with.

It is derived from code. Every claim carries a `file:line`. Where a claim is
design intent the code cannot show, it is marked **inferred** and says what code
would have to grow to make it a fact; where behaviour is asserted by no test it
is marked **not yet proven**. If this page and the code disagree, the code is
right and this page is a bug.

## 1. What this module is

A capability DSO, built as `libtension_ogre.so` (`tension-ogre/CMakeLists.txt:61-66`),
loaded by `tension-core` through the adapter ABI. It exports exactly one symbol,
`tension_adapter_v1` (`tension-ogre/src/adapter.cpp:1572-1584`), which returns a
static `tension_adapter` whose `abi_version` is `TENSION_ADAPTER_ABI_VERSION`
and whose `apply` slot is `nullptr` (`adapter.cpp:1580`). The vtable contract
itself is `docs/abi/adapter.md`; this page does not restate it.

The guest-visible surface is the wasm module `ogre`: sixteen imports, registered
in `link` (`adapter.cpp:1285-1311`) and pinned by name, arity, verb id and flags
in `tension-core/tests/ogre_surface.rs:525`. The guest-side reference generated
from the registration sites is `docs/abi/guest.md`.

The module declares the regions it touches at `link`: two it writes
(`RESOURCE`, `JOB`, `adapter.cpp:1336-1350`) and four it reads (`SCENE`,
`MATERIAL`, `RENDERABLE`, `BUFFER_POOL`, `adapter.cpp:1358-1381`). That set is
pinned by the same test (`ogre_surface.rs:531-539`). Declaration is not a
formality: the session checks the arena against the set, and the adapter
additionally refuses a region that resolves to offset 0 or size 0, because a
forgotten entry in that table would become "read address 0 as guest memory"
(`adapter.cpp:1371-1379`).

**What it owns, and what it does not.** It owns the render thread, every Ogre
object on it, the loader's worker thread, the job/resource tables and the scene
mirror. It does not own the window, the `VkInstance`, or the `VkSurfaceKHR` —
those are the host's (`docs/architecture.md` §2). The `VkDevice` and the
swapchain are made by Ogre from the host's instance and surface
(`backend_ogre.cpp:289`, `:440`), and destroyed by Ogre on the render thread
(`backend_ogre.cpp:698-709`).

**A note on size.** Nine translation units, about 6,300 lines of C++; a guest
SDK of about 1,800 lines across eight TypeScript files. The 3,240-line design
note is not evidence of a 3,240-line contract: roughly 1,400 of its lines are
§5.1's offset table, which the arena now derives from `layout_hash` and
`tension-core/src/session/arena.rs`. The contract a guest can see is sixteen
functions and eleven records.

## 2. The sixteen verbs

Every import is `i32` at the wasm boundary; guest pointers are `u32` offsets
into the guest's own memory (`tension-ogre/include/tension_ogre.h:40-46`). The
`ret` column is what the guest reads back; the shim's own return value is only a
status the session logs, which is why every refusal goes through `refuse()`
(`adapter.cpp:419-425`) — a bare `return -EINVAL` would leave the wasm result
slot at 0 and answer the guest "success".

| # | import | id | wasm signature | what it does | registered / implemented |
|---|---|---|---|---|---|
| 1 | `init` | 1 | `(i32 cfg_ptr, i32 cfg_len) -> i32` | decode the config, start the render thread. 0 means *accepted*, not *window up* | `adapter.cpp:1286`, `:463` |
| 2 | `shutdown` | 2 | `() -> i32` | request stop and join, bounded at 5 s; idempotent | `adapter.cpp:1287`, `:546` |
| 3 | `last_error` | 3 | `(i32 ptr, i32 cap) -> i32` | probe/consume the last diagnostic; `-1` when there is none | `adapter.cpp:1288-1289`, `:561` |
| 4 | `queue_mesh_load` | 4 | `(i32 name_ptr, i32 name_len, i32 priority) -> i32` | copy the name, create a job, hand it to the worker; returns the job id | `adapter.cpp:1290`, `:666` |
| 5 | `queue_texture_load` | 5 | `(i32 name_ptr, i32 name_len, i32 priority) -> i32` | the same, for a texture | `adapter.cpp:1291`, `:713` |
| 6 | `job_state` | 6 | `(i32 job_id, i32 out_ptr) -> i32` | copy one 64-byte `Job` record into guest memory | `adapter.cpp:1293-1294`, `:718` |
| 7 | `job_release` | 7 | `(i32 job_id) -> i32` | free a slot; the record keeps `JOB_RELEASED` | `adapter.cpp:1295`, `:735` |
| 8 | `submit` | 8 | `(i32 kind, i32 id, i32 op) -> i32` | read one record from its region and apply it to the mirror (`kind` 0..4, `op` 0 upsert / 1 remove) | `adapter.cpp:1296`, `:747` |
| 9 | `screenshot` | 9 | `(i32 ptr, i32 cap) -> i32` | probe/consume the last downloaded frame, and arm a download of the next | `adapter.cpp:1297-1298`, `:1179` |
| 10 | `submit_motion` | 10 | `(i32 count) -> i32` | one `guest_read` of `count` 48-byte `MotionUpdate`s, all-or-nothing | `adapter.cpp:1300`, `:868` |
| 11 | `submit_bones` | 11 | `(i32 count) -> i32` | one read of the bone table at `BONE_TABLE_OFFSET`, all-or-nothing | `adapter.cpp:1302`, `:932` |
| 12 | `create_mesh` | 12 | `(i32 vb, i32 vb_len, i32 format, i32 ib, i32 ib_len, i32 topology) -> i32` | copy vertex/index bytes out of the procedural window and return a resource id now, realise later | `adapter.cpp:1305`, `:1081` |
| 13 | `mount_tns` | 13 | `(i32 prefix, i32 prefix_len, i32 path, i32 path_len) -> i32` | read a Tension Volume once and mount it under a prefix | `adapter.cpp:1306`, `:674` |
| 14 | `submit_animation` | 14 | `(i32 renderable, i32 clip, i32 clip_len, i32 time_ms) -> i32` | queue a clip and an absolute time within it | `adapter.cpp:1307`, `:634` |
| 15 | `submit_skin_matrices` | 15 | `(i32 count) -> i32` | read a table of `(id, offset, bytes, flags)` plus the matrix blocks they name | `adapter.cpp:1303`, `:993` |
| 16 | `window_handle` | 16 | `(i32 lo_ptr, i32 hi_ptr) -> i32` | write the cached native window handle as two halves | `adapter.cpp:1310-1311`, `:1230` |

Two properties of the table are load-bearing and easy to miss:

- **Four verbs are `TENSION_IMPORT_REENTRANT_READONLY`**: `last_error`,
  `job_state`, `screenshot`, `window_handle` (`adapter.cpp:1288-1289`,
  `:1293-1294`, `:1297-1298`, `:1310-1311`). They take a lock and copy; none
  pumps an epoch, and each is callable from inside a callback.
- **No verb is `TENSION_IMPORT_DEFERRABLE`**, and the vtable's `apply` is null
  (`adapter.cpp:1580`). A guest cannot call any of these sixteen from inside a
  callback; the session refuses with `-EBUSY`. The only deferrable registration
  in the tree is the test echo adapter
  (`tension-core/tests/support/echo_adapter.c:279`).

Verb ids are the numbers `apply` would receive if the adapter ever grew a
deferred verb; they are assigned in `adapter.cpp:30-56`, where two comments
record off-by-one corrections (`mount_tns` is 13, not 12; `submit_animation` is
14, not 15) because the plan's numbering had drifted from the code's.

## 3. The config record

The wire is the same argmap the session uses: `u32 entry_count`, then per entry
`u32 key`, `u8 tag` (2 = `i64`), `i64 value` little-endian with the upper four
bytes zero (`tension-ogre/src/config.h:7-12`). `abi_version` must be the first
entry and must equal `TENSION_OGRE_ABI_VERSION` (1)
(`tension_ogre.h:131`, `config.cpp:120-129`, `:150-160`).

| key | id | default | accepted range |
|---|---|---|---|
| `abi_version` | 1 | — required | 1 |
| `renderer` | 2 | 1 (`GL3PLUS`) | 0..4 (`config.cpp:162-171`) |
| `headless` | 3 | false | 0/1 (`config.cpp:174-187`) |
| `vsync` | 4 | false | 0/1 |
| `frame_hz` | 5 | 60 | 1..1000 (`config.cpp:17-20`) |
| `window_width` | 6 | 1280 | 1..16384 |
| `window_height` | 7 | 720 | 1..16384 |

Policy, both halves deliberate (`config.h:14-19`): the **structure** is strict —
a truncated entry, a tag that is not 2, a value wider than 32 bits, trailing
bytes, or a missing `abi_version` are each their own refusal (`ConfigError`,
`config.h:29-39`); the **key space** is permissive — an unknown key is validated
structurally and then ignored, because the argmap is a namespace a newer SDK may
grow (`config.cpp:206-214`). A duplicate key takes the last value
(`tension-ogre/tests/config_test.cpp:263`).

Two fields are *not* config keys and no guest can set them: `external_instance`,
`external_surface` and the two function pointers `host_size` / `host_extension`
(`config.h:66-84`). They are filled from the host's table inside `init`
(`adapter.cpp:487-520`). The reason is structural: the values are handles the
host owns, and the function pointers are plain C pointers rather than
`std::function` so that `Config` can be copied into the backend without an
allocation on the render thread (`config.h:68-74`).

**`headless` is decoded, range-checked, stored — and never read.** Nothing in
`tension-ogre/src/` consults `Config::headless` after `config.cpp:182`; only
`renderer = 0` (the NULL render system) avoids opening a window
(`backend_ogre.cpp:243-253`). A guest that sets `headless: true` with
`renderer: gl3plus` gets a window. Recorded as contradiction 20 in
`/home/acakar/work/docs-contradictions.md`. **Not fixed in this pass** — this
page is documentation.

## 4. Records, regions and the schema

This is the section that cannot be read off a single file: a record's byte
layout lives in one place, its meaning lives in the header and the SDK, and its
container lives in `tension-core`.

### 4.1 The twelve regions

The layout is fixed at session open. `kind == index` is the lookup, and the
per-region flags say who may write (`tension-core/src/session/arena.rs:414-427`).
Sizes below are the code's, not the design note's.

| kind | region | size | writer | what `tension-ogre` does with it |
|---|---|---|---|---|
| 0 | `CONTROL` | 256 B | session, once | — |
| 1 | `SESSION_INFO` | 144 B | session, once | — |
| 2 | `FRAME_STATE` | 4 KiB | session | — (the frame counter the guest reads is `Resource.seq`, not `FrameState`) |
| 3 | `JOB` | 48 KiB | session | writes job records in `publish` (`adapter.cpp:1439-1440`) |
| 4 | `RESOURCE` | 48 KiB | session | writes resource records, and the renderer's own at slot 1 (`adapter.cpp:1443-1469`) |
| 5 | `EVENT_TABLE` | 384 KiB | session | — (`post_event` goes through the core, `adapter.cpp:194-199`) |
| 6 | `STRING` | 1 MiB + 32 B | both | — (names cross as `(ptr, len)` and are copied by `guest_read`, `adapter.cpp:596-602`) |
| 7 | `RESOURCE_REQ` | 48 KiB | guest | no live consumer; the only reader outside the layout is the test stub (`tension-core/tests/support/ogre_stub_adapter.c:457`) |
| 8 | `SCENE` | 256 KiB | guest | nodes, cameras, lights |
| 9 | `MATERIAL` | 64 KiB | guest | one table |
| 10 | `RENDERABLE` | 128 KiB | guest | one table |
| 11 | `BUFFER_POOL` | 4 MiB | guest | motion table, bone table, procedural window, skin-matrix window |

The `SCENE`, `MATERIAL` and `RENDERABLE` regions are not one record per region —
they are tables with fixed capacities, and the capacities are literals on both
sides of the boundary:

- `SCENE`: 1024 `SceneNode` (72 B) then 512 `CameraRecord` (80 B) then 1024
  `LightRecord` (88 B) = 204,800 B of 262,144
  (`tension-ogre/src/scene.h:33-37`, `:136-137`;
  `tension-framework/assembly/ogre/wire.ts:259-261`).
- `MATERIAL`: 256 × 200 B = 51,200 of 65,536.
- `RENDERABLE`: 2048 × 56 B = 114,688 of 131,072.
- `BUFFER_POOL`: motion 2048 × 48 B at 0, bones 2048 × 48 B at 98,304,
  procedural window 512 KiB at 196,608, and the skin table (64 × 32 B) plus
  256 KiB of matrices inside that window
  (`scene.h:80-120`; `wire.ts:291-360`). The skin window fits because
  `scene.h:120` asserts it does.

**Not yet proven: nothing ties the two capacity sets together.** `kNodeCapacity
= 1024` (`scene.h:33`) and `SCENE_NODE_COUNT = 1024` (`wire.ts:259`) are
independent literals that happen to agree. The guest's startup check
(`checkSubmissionRegions`, `tension-framework/assembly/ogre/index.ts:461-474`)
asserts that the tables *fit the region*, not that the host's and the guest's
counts are equal. A host count smaller than the guest's would move the host's
table base and misread every camera as a node; a host count larger would leave
tail slots unwritten. No test crosses the boundary to compare them. The remedy
is a schema field or a startup handshake, and neither exists today.

### 4.2 Record shapes

The record layouts **are** derivable from code, which is more than the design
note assumed: `schema/ogre.json` is the single source, and
`tools/codegen/generate.mjs` emits both halves — the guest's structs
(`tension-framework/assembly/ogre/generated/ogre.generated.ts`) and the
adapter's (`tension-ogre/src/generated/ogre.generated.h`) — with 148
`static_assert`s on the C++ side (`ogre.generated.h:148`) and a
`codegen --check` drift gate in `npm test` (`scripts/test.mjs:156-166`). A field
that moves on one side is a compile error on the other, not a silent misread.

| record | bytes | written by | read by |
|---|---|---|---|
| `Vec3fValue` / `QuatfValue` | 12 / 16 | — (value twins, nested inline) | both |
| `SceneNode` | 72 | guest → `SCENE` | adapter `submit` |
| `CameraRecord` | 80 | guest → `SCENE` | adapter `submit` |
| `LightRecord` | 88 | guest → `SCENE` | adapter `submit` |
| `Material` | 200 | guest → `MATERIAL` | adapter `submit` |
| `Renderable` | 56 | guest → `RENDERABLE` | adapter `submit` |
| `MotionUpdate` | 48 | guest → `BUFFER_POOL` | `submit_motion` |
| `BoneUpdate` | 48 | guest → `BUFFER_POOL` | `submit_bones` |
| `Resource` | 48 | adapter `publish` | guest, by offset |
| `Job` | 64 | adapter `publish` | guest, by offset |

Sizes are the generator's (`ogre.generated.h:19-183`); the `Resource` and `Job`
strides are also spelled as constants in the header the tests read
(`tension_ogre.h:210`, `:236`).

Two of the layouts are read by literal offset rather than by struct — the
guest's `resourceState()` / `frameCount()` (`wire.ts:194-245`) and the adapter's
`put_u32` writes into the renderer's record (`adapter.cpp:76-80`). Those offsets
are codegen'd on the guest side, but the adapter's `kResource*Offset` constants
are hand-written and merely *commented* as covered by the layout hash
(`adapter.cpp:74-80`). They agree today; nothing asserts it.

### 4.3 Where the three descriptions disagree

Read `tension-ogre/DESIGN.md` §3-6 for the *why*; do not read it for the *what*.
Every disagreement below was checked against code and the SDK, and code + SDK
win. Four are concrete:

1. **`SESSION_INFO` is 144 bytes, not 128.** `arena.rs:54` (`SESSION_INFO_SIZE =
   144`) and the guest's `tension-framework/assembly/runtime/wire.ts:175-224` (four reserved words to 144) agree;
   `DESIGN.md:341`, `:1477` and `:1756` say 128. The error is invisible in the
   floor arithmetic because the record lives inside the 4 KiB header page
   (`HEADER_PAGE_SIZE`, `arena.rs:60`), which is why it survived.
2. **There are thirteen event classes, not ten.** `arena.rs:124-135` defines
   `CLASS_COUNT = 13` and the three AI classes; `DEFAULT_RING_CAPACITIES` and
   `DEFAULT_CLASS_MODES` are 13 entries (`arena.rs:265-283`). `DESIGN.md:123-134`
   says "Ten classes in chunk 1" and prints a ten-row table. The design note
   does warn in its own next paragraph that the code is normative
   (`DESIGN.md:140-146`), but the table above the warning is stale.
3. **No `queue_*` verb is deferrable.** `DESIGN.md:1959-1960` says
   `TENSION_IMPORT_DEFERRABLE` "marks ... the `queue_*` verbs". The adapter
   registers none of its sixteen with that flag (`adapter.cpp:1285-1311`) and
   ships `apply = nullptr` (`adapter.cpp:1580`); the session therefore refuses
   a callback-time call with `-EBUSY`. The flag is exercised only by the test
   echo adapter.
4. **The SDK's headline count is eleven.** `tension-framework/assembly/ogre/index.ts:1`
   says "the eleven verbs a guest may call", because eleven `@external`
   declarations live in that file (`index.ts:89-121`). Five more live in sibling
   modules — `submit_motion` (`motion.ts:18`), `submit_bones` (`bones.ts:30`),
   `submit_skin_matrices` (`skin.ts:30`), `create_mesh` (`mesh.ts:66`),
   `submit_animation` (`animation.ts:27`). A reader who trusts the first line
   undercounts by five.

Two smaller ones: `tension_ogre.h:16-24` says this header documents each of the
sixteen verbs "below", but only `init`, `shutdown`, `last_error` and
`window_handle` have doc blocks there — the other twelve are documented at
their shims. And `DESIGN.md:337-1750` (§5.1) is an offsets table that the arena
now derives from constants plus `layout_hash`; it was not diffed line by line
for this pass, because the code is the source and the table adds no constraint.

Agreements worth recording, because they are the contract's spine: the vtable
shape (`DESIGN.md:1944-1953` = `tension_adapter.h:674-749`), the TLV shape
(`DESIGN.md:1843-1890` = `config.h:7-12`), kind-equals-index and the 24-byte
`RegionDesc` (`DESIGN.md:1780-1796` = `arena.rs:404-427`), and the Model A
memory model — the session owns the memory, address 0 is the arena, the heap
starts at `memoryBase` (`DESIGN.md:260-271`; `docs/architecture.md` §5).

### 4.4 Rationale the code cannot show

The code shows *what*; three *whys* exist only as comments or as the design
note, and are preserved here so the deletion of `DESIGN.md` does not lose them.

- **Why a worker thread that never calls Ogre.** `DESIGN.md:2098-2106` splits
  the load path at "bytes versus Ogre" so that "is Ogre thread-safe?" never has
  to be answered. The split is real and testable without a renderer: the unit
  test links no Ogre at all (`tension-ogre/CMakeLists.txt:250-254`). *The
  rationale is inferred from the doc; the split it describes is verified.*
- **Why the renderer's record is resource id 1 and the loader starts at 2.** The
  comment at `loader.h:266-277` records the measured bug: a rigged mesh's
  `isRigged()` read came back false because the record it read was the
  renderer's. Ids are slot indexes plus one (`loader.h:64-69`), so the two
  tables cannot disagree about where a record lives.
- **Why the design note's 30-frame sleep window is not here.** It is physics —
  `DESIGN.md:1094-1152`, about when a rigid body sleeps — and belongs to the
  cut `tension-solver` material. It is not an ogre behaviour and is not
  preserved by this page.

## 5. The render thread

One thread, created in `init` (`adapter.cpp:538-540`), and the only thread that
ever touches an Ogre object (`backend.h:1-12`). The thread body is `render_main`
(`adapter.cpp:240-413`) and its lifecycle is four phases:

1. **Start.** Pick the renderer chain — the operator's `TENSION_RENDERER` wins
   over the guest's config, and only `auto` produces a chain of more than one:
   `vulkan → gl3plus → null` on this platform, `d3d11 → vulkan → gl3plus → null`
   on Windows (`adapter.cpp:174-191`). An explicit choice refuses rather than
   falling back (`adapter.cpp:152-171`). Then for each candidate, `make_backend` and
   `start` (`adapter.cpp:303-329`). A failed candidate is stopped and the next
   tried; if none starts, `fail(...)` posts `DEVICE_LOST` and the thread exits
   (`adapter.cpp:330-335`). On success, `RESOURCE_READY` is posted once
   (`adapter.cpp:338-340`). The first frame is rendered inside `start`, *before*
   readiness is announced, so "ready" means "a frame presented"
   (`backend_ogre.cpp:606-616`).
2. **Frame.** Each iteration drains finished loads onto the render thread
   (`adapter.cpp:347`), applies the scene mirror under the guest lock
   (`:351-357`), applies queued animation requests (`:366-383`), renders
   (`:386`), signals the host (`:396-397`), then waits on the pacing period or a
   stop (`:399-403`). The period is `1000 / frame_hz`, defaulting to 60 Hz
   (`:341-342`).
3. **Stop.** `stop_requested` (set by `shutdown` or the destructor) ends the
   loop; the loop calls `backend->stop` on the thread that made the backend
   (`adapter.cpp:406`).
4. **Exit.** `finish_thread` fails every in-flight job with `-EIO`, resets the
   backend **on this thread**, sets `thread_exited` and notifies
   (`adapter.cpp:224-238`). The sweep is one call, not two, because a guest
   queueing at that instant must not slip between the sweep and the latch
   (`loader.h:190-201`).

The ordering invariant that matters: **the backend is destroyed on the thread
that created it**, before the join completes. Reversing it — dropping
`AdapterState::backend` while the thread still draws — is the measured SIGSEGV
in the windowed build and SIGABRT headless (`adapter.cpp:1547-1552`). That is
also why `~AdapterState` calls `stop_render_thread()` rather than relying on
member destruction (`adapter.cpp:1553-1568`).

The thread's three partners, and what each may touch:

- **guest thread** (interpreter): writes the mirror under `scene_mutex`
  (`adapter.cpp:756`), queues animations under `mutex` (`:658-661`), reads
  status snapshots. Never touches Ogre.
- **loader worker**: resolves paths through the mount table, reads bytes, checks
  magic, reports an errno. Calls no Ogre function (`loader.h:1-14`). Mounts are
  heap-stable and append-only, so a pointer taken under the lock stays valid
  outside it (`mounts.h:11-17`).
- **render thread**: every Ogre call, including the parse and creation in
  `drain_completions` (`loader.h:169-172`).

**The freeze risk is inherited, not new.** A guest that never yields blocks the
interpreter thread, and with it `publish` (so no job or resource record is
updated), every adapter import, and the host's own pump — so the window manager
cannot close the window. The render thread keeps drawing
and signalling frames; what stops is everything that needs the guest to return.
This is `docs/architecture.md` §4's named risk, seen from the render side; it is
not fixed and no scheduler pass owns it yet.

## 6. The host surface path

When the host publishes a `tension_host_surface` with a non-zero instance and
surface, `init` copies both handles, the host's current size, and two readers
into `Config` (`adapter.cpp:487-520`). The window size the guest asked for is
overridden by the host's, because the guest is not getting a window of its own
(`adapter.cpp:508-512`).

The backend then takes a path that is deliberately narrow — Vulkan, and only
when an instance was supplied:

- `deferred_vulkan = vulkan_rs && config.external_instance != 0`
  (`backend_ogre.cpp:289`). Every other combination behaves exactly as it did
  before ABI v6.
- The plugins config file omits the Vulkan plugin, because `Root::loadPlugin` is
  the only route that accepts plugin params and `external_instance` is read on
  the first load (`backend_ogre.cpp:296-320`; measured: `OgreRoot.cpp:1474-1476`).
- At plugin-load time, on Vulkan, `ensure_glslang_global` dlopens the plugin
  once and, if that fails, preloads `libglslang.so.16` (then the unversioned
  soname) with `RTLD_GLOBAL` (`backend_ogre.cpp:169-183`). The reason is an
  upstream linking defect — `RenderSystem_Vulkan.so` leaves glslang's symbols
  undefined — and it is a workaround, not a contract.
- A `VulkanExternalInstance` is allocated, its `instance` set from the host's
  handle, `instanceLayers` left empty, and `instanceExtensions` filled by
  iterating `host_surface_extension` until `-ENOENT`
  (`backend_ogre.cpp:337-392`). The list must come from the host because Ogre
  treats the caller's list as the record of what is enabled and only sanity
  checks it against enumeration (`backend_ogre.cpp:365-380`).
- `createRenderWindow` receives `external_surface` in its params
  (`backend_ogre.cpp:430-441`); Ogre adopts the surface and creates no native
  window (`third_party/patches/ogre-external-surface.patch`).

**Resize.** With an external surface there is no native window for Ogre to
measure, so nothing else would notice a host resize. Once per frame the backend
reads the host's current size and, when it differs from the window's, logs
`host surface is WxH, window is AxB — requesting a swapchain rebuild` and calls
`requestResolution` (`backend_ogre.cpp:643-658`). This is the only consumer of
the resize patch hunk; the hunk has been executed at runtime, and the frame
after it presented at the new size (`tension-core/tests/ogre_host_surface.rs`,
assertions d–e).

**Teardown order on this path** (`backend_ogre.cpp:681-722`): clear the scene,
discard every resource, clear the cached native handle, `destroyRenderWindow`
(which destroys the swapchain), `root_->shutdown()`, `root_.reset()`, then
`external_instance_.reset()`. The `VulkanExternalInstance` is declared *before*
`root_` so that it is destroyed *after* it (`backend_ogre.cpp:2257-2262`): the
render system holds a pointer to that struct while shutting down. Freeing it
first would leave Ogre reading freed memory.

Without a host surface the module is unchanged from the pre-v6 path: the plugin
is named in `plugins.cfg`, Ogre creates its own window, and the native handle is
cached for `window_handle` (`backend_ogre.cpp:455-480`). On this rig that
handle is non-zero; under a host surface it stays 0 and `window_handle` answers
`-ENODEV` — deliberately, until the v7 input pass re-points it
(`tension-core/tests/ogre_host_surface.rs`, assertion f).

## 7. Failure modes

Refusals come back as negative errno in `ret`; the shim's own return is a
status. The list by verb, with the checks that produce each code:

- **`init`** — `-EINVAL` for arity, a config longer than 512 bytes, an
  unreadable pointer, or any `ConfigError` (`adapter.cpp:463-486`); `-EBUSY`
  while another init is running or a shutdown is in progress (`:527-533`).
  Asynchronous failures do not come back here: a missing plugin, an unknown
  render system, a refused window or a failed first frame arrive later as
  `DEVICE_LOST` with a stage code (`tension_ogre.h:155-179`,
  `backend_ogre.cpp:255-616`).
- **`shutdown`** — `0` when nothing ran; otherwise the join's result, `-EIO` if
  the thread did not stop within 5 s, in which case it is detached
  (`adapter.cpp:546-559`, `:1508-1536`).
- **`last_error` / `job_state` / `screenshot` / `window_handle`** — `-EBUSY`
  when the API table or `guest_write` is null (the pre-`init` case), `-EINVAL`
  for arity or a refused write.
- **`queue_mesh_load` / `queue_texture_load`** — `-EINVAL` for an empty or
  oversized name (4096-byte ceiling, `adapter.cpp:61-66`), `-ENOSPC` when the
  768-slot job table is full (`loader.h:118-119`, `:139-141`). A path that cannot be
  resolved is not this verb's refusal: the job is created and later fails with
  `-ENOENT` in its record and a `JOB_FAILED` event.
- **`job_state` / `job_release`** — `-ENOENT` for an id with no slot
  (`loader.h:145-152`).
- **`submit`** — `-EINVAL` for a bad kind, op, id, record decode, or a mirror
  rule (a renderable naming a dead material or a mesh that is not `READY`;
  `scene.cpp:216-235`), `-EBUSY` for a node removed while children live
  (`scene.cpp:146`, `:151`).
- **`submit_motion`** — `-EINVAL` for a count outside 1..2048, a region smaller
  than the batch, or a decode failure; `-ENOENT` for an entry naming a renderable
  that is not live. The batch is all-or-nothing: every entry is validated before
  any is applied (`adapter.cpp:868-928`).
- **`submit_bones`** — the same shape, plus `-EINVAL` from the mirror for a
  non-rigged target or a bone index past the rig's count
  (`scene.cpp:306-320`).
- **`submit_skin_matrices`** — `-EINVAL` for shapes, strides, or a matrix block
  that runs past the window (`adapter.cpp:1034-1051`).
  **Inconsistent with the two batch verbs:** it does not check that the
  renderable is live. `SceneMirror::set_skin_matrices` silently ignores an id
  outside 1..2048 and stores matrices for an id that is not live
  (`scene.cpp:247-251`), so the verb returns 0 with `ret = count` even when
  nothing was stored. The apply pass only reads matrices for live rigged
  renderables (`backend_ogre.cpp:2025-2040`), so nothing is corrupted — but a
  guest cannot tell a silent drop from a success.
- **`create_mesh`** — `-EINVAL` for a topology other than a triangle list, a
  format without `VF_POSITION` or with unknown bits, vertex bytes that are not a
  whole number of vertices, index bytes that are not whole triangles, arrays
  outside the 512 KiB procedural window, overlapping arrays, or any index past
  the vertex count; `-ENOSPC` when the resource table is full
  (`adapter.cpp:1081-1176`).
- **`mount_tns`** — `-EINVAL` for an empty or malformed prefix, `-EEXIST` for a
  duplicate prefix (`mounts.h:43-46`), and the resource library's own errno when
  the volume cannot be opened or parsed (`adapter.cpp:695-711`).
- **`window_handle`** — `-ENODEV` when there is no window: before `init`, while
  the window is coming up, with the null renderer, or after `shutdown`
  (`adapter.cpp:1230-1251`). This is the one code the adapter returns that is
  not in the adapter ABI's closed list; `tension_ogre.h:249-261` records the
  deviation and the one-line amendment the core owes.

## 8. Tests

**C++ unit tests** — no Ogre linked; run by `node scripts/build-ogre.mjs --test`
(suite `ogre-unit`, `scripts/test.mjs:197-201`;
`tension-ogre/CMakeLists.txt:242-261`):

- `config_test.cpp` — round trip, defaults, golden bytes, unknown key ignored,
  duplicate takes last, every refusal token, key names (`config_test.cpp:260-268`).
- `scene_test.cpp` — node/camera/light/material/renderable rules, cycle and
  depth-32 refusals, motion and bone batches, all-or-nothing, field offsets
  (`scene_test.cpp:585-616`).
- `loader_test.cpp` — id allocation, `-ENOSPC`, release, `-ENOENT`, dirty-only
  mirroring, worker completion and failure, backend refusal, sweep, procedural
  mesh realisation (`loader_test.cpp:527-548`).

**Rust integration tests** (`cargo test --test <name>`):

- `ogre_smoke.rs` — the DSO loads under both renderers and registers.
- `ogre_surface.rs` — the sixteen imports with their flags, the event source,
  the declared region set, `publish` as a no-op while clean, `shutdown`
  idempotent before `init` (`ogre_surface.rs:525-552`).
- `ogre_hierarchy.rs` — a guest fixture's hierarchy, structurally and in pixels.
- `ogre_host_surface.rs` — the host-owned path end to end: instance and surface
  non-zero, adapter adopts them, frame 1 presents, screenshot dimensions
  320×240, host resize to 640×480, `requestResolution`, frame 2 presents,
  screenshot 640×480, `window_handle` `-ENODEV`, clean teardown.

**Guest fixtures** — `scripts/test-ogre.mjs`: 18 cases by default and 35 with
`TENSION_OGRE_WINDOW_TEST=1`, whose 17 opt-in cases include the whole
`*-gl3plus` renderer matrix and the four pixel-clause fixtures. The opt-in set
ran for the first time on 2026-11-07 and passes.

**What no test covers, and where a claim above is therefore [I]:** the
cross-language capacity agreement (§4.1); `submit_skin_matrices` liveness (§7);
the inert `headless` key (§3); the Windows path (`#if defined(_WIN32)` branches
compile only on that target).

## 9. Non-goals

- The record/region rationale in full — §4.3 records what disagrees and §4.4
  what would otherwise be lost; the design note is the long form until pass 5
  deletes it.
- The adapter ABI itself: `docs/abi/adapter.md`, generated from
  `tension-core/include/tension_adapter.h`.
- The guest-visible import list: `docs/abi/guest.md`, generated from the
  registration sites.
- Ownership and teardown of the host's window, instance and surface:
  `docs/architecture.md` §2-3.
- Input attach and `window_handle`'s re-point: deferred to the v7 input pass.
- The 2D capability: `docs/modules/2d.md`.
- Build and CI: `docs/build.md`.

## 10. Source index

Files this page was derived from, and what each answers:

- `tension-ogre/include/tension_ogre.h` — the guest boundary: keys, renderer
  ids, stages, event classes, job/resource states, the errno deviation.
- `tension-ogre/src/adapter.cpp` — verb ids, shims, registration table,
  `render_main`, publish, shutdown, the DSO's one export.
- `tension-ogre/src/adapter.h` — `AdapterState`: which lock guards what.
- `tension-ogre/src/backend_ogre.cpp` — Ogre start/frame/stop, the host-surface
  branch, resize, readback, teardown order.
- `tension-ogre/src/backend.h` — the backend contract and the thread rule.
- `tension-ogre/src/config.h`, `config.cpp` — the TLV wire and its refusals.
- `tension-ogre/src/loader.h`, `loader.cpp` — jobs, the worker, the drain latch,
  mirroring.
- `tension-ogre/src/scene.h`, `scene.cpp` — the mirror's rules and capacities.
- `tension-ogre/src/mounts.h`, `mounts.cpp` — volume mounts and path resolution.
- `tension-ogre/src/status.h`, `status.cpp` — the render thread's write channel.
- `tension-ogre/src/generated/ogre.generated.h`, `schema/ogre.json`,
  `tools/codegen/generate.mjs` — record shapes and the drift gate.
- `tension-framework/assembly/ogre/*.ts` — the guest SDK and its assertions.
- `tension-core/src/session/arena.rs` — the region table and capacities.
- `third_party/patches/ogre-external-surface.patch` — the three Ogre-side hunks
  (external surface, resize, teardown guard).
