/*
 * tension_2d — the 2D capability's boundary header.
 *
 * The counterpart of tension_adapter.h for one capability: it fixes the wasm
 * import surface (`tension::2d`) the adapter implements, the nine verbs, the
 * `sprite` record the guest submits, and the refusal vocabulary. The guest SDK
 * and the adapter's C++ sources both answer to it, and neither invents a field
 * the other does not know.
 *
 * The design is tension-2d/DESIGN.md; this header is its wire, in C, and where
 * the two disagree the design is the argument and this is the shape.
 *
 * This header includes no SDL header, on purpose. The adapter's SDL-facing
 * includes live in src/render.cpp, where they cannot leak into the wire
 * contract; the platform lives in the DSO.
 *
 * SPDX-License-Identifier: MIT
 */
#ifndef TENSION_2D_H
#define TENSION_2D_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* ── the imports this adapter registers ──────────────────────────────── */

/*
 * The wasm-facing surface, module name "tension::2d". The guest declares these
 * with `@external("tension::2d", ...)`; the adapter registers them through
 * `tension_core_api.register_import`, in `link`. Every parameter and return is
 * `i32` (tension_adapter.h rule 3: there is no `size_t` at this boundary).
 *
 * Guest pointers are `u32` offsets into the guest's own memory — the adapter
 * reaches that memory only through `guest_read` / `guest_write`, inside a
 * guest-initiated call, and never holds it across one (rule 6).
 *
 * The adapter owns **no regions**: the vtable's `publish` is NULL, and no verb
 * depends on one. Sprite state reaches the renderer through `submit`, not
 * through shared memory.
 */

/*
 * `open(i32 flags) -> i32`  — verb_id 1, flags 0.
 *
 * Creates the GPU device and the capability's one session (capacity 1), and
 * returns its handle, or:
 *   -EINVAL  `flags` is not 0 (none are defined yet)
 *   -EBUSY   a handle is already open
 *   -ENODEV  no GPU device on this machine (no driver, no Vulkan ICD)
 *   -ENOSYS  this SDL build has no GPU backend
 *   -EIO     device creation failed for a reason SDL names
 *
 * v1 renders to an offscreen target and reads it back with `screenshot`; there
 * is no swapchain yet, so `open` takes no window token.
 */
int32_t tension_2d_open(int32_t flags);

/*
 * `close(i32 handle) -> i32`  — verb_id 2, flags 0.
 *
 * Releases every texture, pipeline, buffer, the target and the device. Returns
 * 0, or -EINVAL for an unknown handle.
 *
 * This is the teardown that actually runs: the host never calls the vtable's
 * `shutdown`/`destroy` (tension-input/DESIGN.md §3), so a capability holding
 * device state must release it through a verb.
 */
int32_t tension_2d_close(int32_t handle);

/*
 * `set_pipeline(i32 handle, i32 blob_ptr, i32 blob_len) -> i32`  — verb_id 3.
 *
 * Prepares a pipeline and returns its `pipe_id`.
 *
 * At v1 the only accepted form is a **built-in preset**, addressed by passing
 * `blob_ptr == 0` and `blob_len` = the preset id (1..9). A guest-authored graph
 * blob (pipe_id 100..999) is -ENOSYS until the graph compiler lands; the ranges
 * are fixed now so a guest can branch on them without a version check.
 *
 *   pipe_id 1..99     built-in presets
 *   pipe_id 100..999  guest-authored graphs (v1: -ENOSYS)
 *   pipe_id 1000+     `shader_compile_raw` provenance
 *
 * Returns a positive `pipe_id`, or:
 *   -EINVAL   bad handle, or a malformed blob header
 *   -ENOENT   a preset id outside 1..9
 *   -ENOSYS   a guest graph in a build with no graph compiler
 *   -ENOSPC   the pipeline table is full
 *   -EIO      shader translation or pipeline creation failed
 */
int32_t tension_2d_set_pipeline(int32_t handle, int32_t blob_ptr, int32_t blob_len);

/*
 * `shader_compile_raw(i32 handle, i32 vs_ptr, i32 vs_len, i32 fs_ptr, i32
 * fs_len) -> i32`  — verb_id 4.
 *
 * The trust-users door: two shader sources in, a `pipe_id >= 1000` out. No
 * layout is validated against the source, because there is no layout — that is
 * what the caller gave up by not sending a graph.
 *
 * At v1 this answers -ENOSYS: the tree has no GLSL -> SPIR-V translator linked
 * into the DSO (DESIGN.md §8.1), so the door exists in the wire and not yet in
 * the build.
 */
int32_t tension_2d_shader_compile_raw(int32_t handle, int32_t vs_ptr, int32_t vs_len,
                                      int32_t fs_ptr, int32_t fs_len);

/*
 * `submit(i32 handle, i32 pipe_id, i32 hdr_ptr, i32 z_bucket) -> i32`  — verb_id
 * 5.
 *
 * Appends the records at `hdr_ptr` to bucket `z_bucket` for the next `present`,
 * and returns how many were accepted. One `guest_read` per submit: the header
 * and the whole record array are copied, and the guest pointer is not kept.
 *
 * `hdr_ptr` addresses a `tension_2d_submit_hdr` (12 bytes) followed by
 * `records_count` records of `record_stride` bytes. `record_stride` must equal
 * the layout's record size, or -EINVAL.
 *
 * A short bucket answers -ENOSPC and the caller splits and re-submits — which
 * is why a count comes back rather than a bare status.
 *
 * Returns the count (>= 0), or:
 *   -EINVAL   bad handle, bad header, `record_stride` disagrees with the
 *             pipeline's layout, or the guest array is unreadable
 *   -ENOENT   unknown `pipe_id`
 *   -ENOSPC   the bucket's staging buffer is full
 */
int32_t tension_2d_submit(int32_t handle, int32_t pipe_id, int32_t hdr_ptr, int32_t z_bucket);

/*
 * `present(i32 handle) -> i32`  — verb_id 6, flags 0.
 *
 * Draws every bucket recorded since the last `present`, in ascending bucket
 * order, one draw call per bucket, then clears the staging state.
 *
 * Returns 0, or -EINVAL for an unknown handle, -ENODEV with no device, -EIO if
 * submission failed.
 */
int32_t tension_2d_present(int32_t handle);

/*
 * `texture_load(i32 handle, i32 src_ptr, i32 src_len, i32 target_format) -> i32`
 *  — verb_id 7.
 *
 * Decodes `src_len` bytes at `src_ptr` and uploads one texture, returning its
 * id (1-based), or:
 *   -EINVAL   bad handle, unknown `target_format`, empty source
 *   -ENOSYS   a container or source layout this build does not serve
 *   -EIO      decode failed
 *   -ENODEV   no device
 *   -ENOMEM   allocation failed
 *
 * v1 reads **IWI** (`IWI1`, the format `IWImageIO.ixx` writes) with interleaved
 * 8-bit RGB or RGBA components. PNG and JPEG need ImageViewer's plugin DSOs and
 * arrive with `iw_decode_to_format` (DESIGN.md §8); until then they are
 * -ENOSYS, not a guess.
 */
int32_t tension_2d_texture_load(int32_t handle, int32_t src_ptr, int32_t src_len,
                                int32_t target_format);

/*
 * `info(i32 handle, i32 ptr, i32 cap) -> i32`  — verb_id 8,
 * flags TENSION_IMPORT_REENTRANT_READONLY.
 *
 * Writes a `tension_2d_info` (16 bytes) into guest memory and returns the bytes
 * written, or -EINVAL / -ENOSPC / -ENODEV.
 *
 * Read-only and re-entrant: it takes a snapshot of counters and never blocks,
 * so a callback may ask how much room it has.
 */
int32_t tension_2d_info(int32_t handle, int32_t ptr, int32_t cap);

/*
 * `screenshot(i32 handle, i32 ptr, i32 cap) -> i32`  — verb_id 9, flags 0.
 *
 * Copies the last presented frame into guest memory as RGBA8, top-left origin,
 * non-premultiplied, and returns the bytes written (`w * h * 4`), or:
 *   -EINVAL   bad handle
 *   -ENODEV   nothing has been presented yet
 *   -ENOSPC   `cap` is smaller than `w * h * 4`
 *   -EIO      the download failed
 *
 * Not re-entrant: it waits for the GPU, which no callback may do.
 */
int32_t tension_2d_screenshot(int32_t handle, int32_t ptr, int32_t cap);

/* ── the `sprite` record (DESIGN.md §5) ──────────────────────────────── */

/*
 * 28 bytes, naturally aligned, no packed fields. Shaders read it as seven
 * little-endian `u32` words out of a std430 storage buffer, indexed by
 * `gl_InstanceIndex`.
 *
 *   offset  field      type
 *     0     x          i32    world position, pixels
 *     4     y          i32
 *     8     src_x      u16    atlas sub-rectangle, pixels
 *    10     src_y      u16
 *    12     w          u16    on-screen size, pixels
 *    14     h          u16
 *    16     tex        u16    atlas page index (multi-atlas)
 *    18     —          pad    two bytes; aligns sort_key
 *    20     sort_key   u32    depth, larger draws later
 *    24     group_id   u16    composite grouping
 *    26     z          u8     within-group order
 *    27     flags      u8     the graph's to interpret; the adapter assigns
 *                            no meaning to any bit
 */
#define TENSION_2D_RECORD_SIZE 28u

#define TENSION_2D_OFF_X         0u
#define TENSION_2D_OFF_Y         4u
#define TENSION_2D_OFF_SRC_X     8u
#define TENSION_2D_OFF_SRC_Y    10u
#define TENSION_2D_OFF_W        12u
#define TENSION_2D_OFF_H        14u
#define TENSION_2D_OFF_TEX      16u
#define TENSION_2D_OFF_SORT_KEY 20u
#define TENSION_2D_OFF_GROUP_ID 24u
#define TENSION_2D_OFF_Z        26u
#define TENSION_2D_OFF_FLAGS    27u

/* ── submit header ───────────────────────────────────────────────────── */

/*
 * The 12-byte block `hdr_ptr` addresses. The records follow it, so a caller
 * writes one header and one array.
 */
typedef struct tension_2d_submit_hdr {
    uint32_t records_ptr;   /* guest address of the first record */
    uint32_t records_count; /* number of records */
    uint16_t record_stride; /* bytes per record; must equal the layout's */
    uint16_t flags;         /* must be 0 */
} tension_2d_submit_hdr;

/* ── info record ─────────────────────────────────────────────────────── */

typedef struct tension_2d_info_record {
    uint16_t version;       /* 1 */
    uint16_t max_records;   /* per bucket */
    uint32_t max_textures;
    uint32_t max_pipelines;
    uint16_t max_buckets;
    uint16_t flags;
} tension_2d_info_record;

/* ── pipe_id ranges ──────────────────────────────────────────────────── */

#define TENSION_2D_PIPE_PRESET_MIN 1
#define TENSION_2D_PIPE_PRESET_MAX 99
#define TENSION_2D_PIPE_GUEST_MIN  100
#define TENSION_2D_PIPE_GUEST_MAX  999
#define TENSION_2D_PIPE_RAW_MIN    1000

/* ── texture target formats ──────────────────────────────────────────── */

#define TENSION_2D_TEX_RGBA8      1 /* SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM */
#define TENSION_2D_TEX_RGBA8_SRGB 2 /* ..._UNORM_SRGB */
#define TENSION_2D_TEX_R8         3 /* ..._R8_UNORM */
#define TENSION_2D_TEX_RGBA16F    4 /* ..._R16G16B16A16_FLOAT */

/* ── refusals ────────────────────────────────────────────────────────── */

/*
 * The vocabulary is tension_adapter.h's, with the same one recorded exception
 * both other capability headers carry: -ENODEV is not in the boundary's closed
 * list, and it is what "no GPU device, nothing to render into" answers with,
 * because none of the listed codes names that state. The amendment
 * tension-core owes is one line in that list; until it lands, this header and
 * tension_ogre.h / tension_input.h are where the deviation is recorded.
 *
 *   -EINVAL  a bad handle, a non-zero `flags`, a malformed header, a stride
 *            that disagrees with the layout
 *   -ENOENT  an unknown pipe_id, or a preset id outside 1..9
 *   -ENODEV  no device, or nothing presented yet
 *   -ENOSYS  a guest graph, a raw shader, or a container this build does not
 *            serve
 *   -ENOSPC  a short bucket, a short guest buffer, a full pipeline table
 *   -EIO     SDL refused, or a decode or download failed
 *   -ENOMEM  allocation failure
 */

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* TENSION_2D_H */
