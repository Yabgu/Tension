// The scene mirror: the adapter's host-side copy of what the guest has
// submitted, and the only place scene records are decoded.
//
// No OGRE type appears here. The mirror is a bookkeeper: five fixed tables
// (nodes, cameras, lights, materials, renderables), a dirty list per table, and
// the decode of one record out of a guest-written region. The render thread
// reads the dirty lists and makes OGRE objects out of them (3b-ii); the unit
// tests read everything else.
//
// Capacity and geometry come from the wire catalogue and the arena layout:
// SCENE is 256 KiB and holds three sub-tables end to end (DESIGN.md §5.1),
// MATERIAL is 64 KiB of 200-byte records, RENDERABLE 128 KiB of 56-byte ones.

#ifndef TENSION_OGRE_SCENE_H
#define TENSION_OGRE_SCENE_H

#include <cstddef>
#include <cstdint>
#include <functional>
#include <string>
#include <unordered_map>
#include <vector>

#include "../include/tension_ogre.h"
// The wire records, generated from schema/ogre.json. Included here rather than
// inside `namespace tension_ogre` because the generated header opens the
// namespace itself.
#include "generated/ogre.generated.h"

namespace tension_ogre {

/// Capacities, from the region sizes and the record sizes.
constexpr uint32_t kNodeCapacity = 1024;
constexpr uint32_t kCameraCapacity = 512;
constexpr uint32_t kLightCapacity = 1024;
constexpr uint32_t kMaterialCapacity = 256;
constexpr uint32_t kRenderableCapacity = 2048;

// ── The record sizes: contract, and the one place they exist twice ─────
//
// These eight constants are the *wire* record sizes, and they are not
// derivable from the structs below: the C++ structs are deliberate prefixes
// (SceneNode 64 of 72, Camera 60 of 80, Light 68 of 88, Material 88 of 200),
// so `sizeof` answers a different and smaller question. They are contract.
//
// Each one therefore exists twice — here as a literal, and in
// `tension-framework/assembly/ogre/wire.ts` as the guest's own size. The tie is
// the guest-side assertion named beside each constant: that is what fails when
// one side moves. A `static_assert(kNodeRecordBytes == 72)` here would compare
// the constant against itself and catch nothing. Mechanizing the tie is the
// generator question in `docs/engine-adoption-plan.md`.

// Must match sizeof<SceneNode>() in tension-framework/assembly/ogre/wire.ts:836
// (asserted guest-side).
constexpr uint32_t kNodeRecordBytes = 72;
// Must match sizeof<CameraRecord>() in tension-framework/assembly/ogre/wire.ts:843
// (asserted guest-side).
// 80, not 60: the two `reserved` u64 words after the viewport round it up.
constexpr uint32_t kCameraRecordBytes = 80;
// Must match sizeof<LightRecord>() in tension-framework/assembly/ogre/wire.ts:840
// (asserted guest-side).
constexpr uint32_t kLightRecordBytes = 88;
// Must match sizeof<Material>() in tension-framework/assembly/ogre/wire.ts:847
// (asserted guest-side).
constexpr uint32_t kMaterialRecordBytes = 200;
// Must match sizeof<Renderable>() in tension-framework/assembly/ogre/wire.ts:864
// (asserted guest-side).
constexpr uint32_t kRenderableRecordBytes = 56;

/// The longest parent chain a submission may create. OGRE's scene graph walks
/// a parent's descendants on every change, so the adapter refuses to build a
/// chain deeper than this rather than letting a guest choose the recursion
/// depth — `-EINVAL`, with the depth logged.
constexpr uint32_t kMaxNodeDepth = 32;

/// One motion-table entry: `wire.ts`'s `MotionUpdate`, 48 bytes with the
/// transform at 8 / 20 / 36 -- right after the id pair, no pads.
/// Must match sizeof<MotionUpdate>() in tension-framework/assembly/ogre/wire.ts:753
/// (asserted guest-side).
constexpr uint32_t kMotionRecordBytes = 48;
/// The table's capacity. `min(RENDERABLE_COUNT, BUFFER_POOL_SIZE / 48)` =
/// min(2048, 87381) = 2048: the renderable table is the smaller bound, and the
/// arithmetic is asserted where the region is declared.
constexpr uint32_t kMotionCapacity = kRenderableCapacity;

/// One bone-table entry: `wire.ts`'s `BoneUpdate`, the motion record's layout
/// with `boneIndex` where `flags` was. It lives in `BUFFER_POOL` past the motion
/// table, so `kBoneTableOffset` is an offset within the region.
/// Must match sizeof<BoneUpdate>() in tension-framework/assembly/ogre/wire.ts:790
/// (asserted guest-side).
constexpr uint32_t kBoneRecordBytes = 48;
constexpr uint32_t kBoneTableOffset = kMotionRecordBytes * kMotionCapacity;
constexpr uint32_t kBoneCapacity = kRenderableCapacity;

/// The procedural-mesh window (chunk 5.5): past the motion table and the bone
/// table, 512 KiB shared by the vertex and the index array one `create_mesh`
/// call names. `wire.ts` derives the same start from the same two tables and
/// pins it at 192 KiB; 512 KiB is ~43,000 vertices at 12 B, which is what makes
/// a 16-bit index sufficient here rather than merely convenient.
constexpr uint32_t kProceduralBase = kBoneTableOffset + kBoneRecordBytes * kBoneCapacity;
constexpr uint32_t kProceduralCapacity = 512 * 1024;

/// The guest's skin matrices (chunk 19 round 19b): a table of 32-byte records
/// at the start of the procedural window, then the matrix bytes the records
/// point at. `wire.ts` derives the same offsets from the same base, so the two
/// sides agree by construction rather than by comment.
/// Must match `SKIN_SIZE` in tension-framework/assembly/ogre/wire.ts:681. This
/// one has *no* struct on either side, so its tie is weaker than the others':
/// two literals and a guest constant, with no `sizeof` assertion to fail. A
/// change here is caught by the skin fixtures, not by a layout assert.
constexpr uint32_t kSkinRecordBytes = 32;
constexpr uint32_t kSkinCapacity = 64;
constexpr uint32_t kSkinTableOffset = kProceduralBase;
constexpr uint32_t kSkinDataOffset = kSkinTableOffset + kSkinRecordBytes * kSkinCapacity;
constexpr uint32_t kSkinDataCapacity = 256 * 1024;
/// The most joints one renderable may send: 128 x 16 floats = 8 KiB. This is
/// also the Hlms buffer's per-object stride, so the two ceilings are one
/// number.
constexpr uint32_t kSkinMaxBones = 128;
static_assert(kSkinDataOffset + kSkinDataCapacity <= kProceduralBase + kProceduralCapacity,
              "the skin-matrix area must fit the procedural window it shares");

/// The vertex-element bits `create_mesh`'s `format` takes, in the order the
/// adapter declares them: position, then normal, then uv. Position is the only
/// element the renderer requires — the probe measured a constant-colour Unlit
/// draw rendering identically with position alone and with all three.
constexpr uint32_t kVfPosition = 1u << 0;
constexpr uint32_t kVfNormal = 1u << 1;
constexpr uint32_t kVfUv = 1u << 2;

/// `create_mesh`'s topology: a triangle list. The only one this adapter
/// declares; anything else is refused `-EINVAL` rather than guessed at.
constexpr uint32_t kTopoTriangleList = 0;

/// SCENE's internal split: nodes, then cameras, then lights, end to end.
constexpr uint32_t kCameraTableOffset = kNodeCapacity * kNodeRecordBytes;
constexpr uint32_t kLightTableOffset = kCameraTableOffset + kCameraCapacity * kCameraRecordBytes;

// ── The decoded records ────────────────────────────────────────────────
//
// **The records are generated.** `schema/ogre.json` is the single source;
// `tools/codegen/generate.mjs` emits this header and the guest's
// `assembly/ogre/generated/ogre.generated.ts` from the same field lists, so
// the two sides cannot disagree about a field's offset without a build
// failure. The 108 hand-written `static_assert`s that used to pin each field
// here are gone: the generated header carries one per field, computed from the
// schema rather than copied by hand.
//
// **Full width, not a prefix.** Each struct is exactly the wire record, so the
// one `memcpy` in `scene.cpp` copies the whole thing. The old prefix design
// (SceneNode 64 of 72, Camera 60 of 80, Light 68 of 88, Material 88 of 200)
// decoded only the fields this adapter reads and ignored the tail; it is
// abandoned for codegen unity. The cost is the tail bytes per record — 8 for
// SceneNode, 112 for Material — copied and never read.
//
// **No `#pragma pack`.** The wire's layout is the naturally aligned one:
// `LightRecord.reserved` sits at 80 and `Resource.seq` at 40 because a `u64`
// aligns to 8 after `u32`s. Packing would delete those pads and shrink three
// records below their wire size (measured: 84/76/44 packed against 88/80/48
// natural), which is exactly what the generated `static_assert`s would then
// catch.
// The prefix-decode note, once, for the four that are shorter: the bytes after
// the struct's size are never read, so a field added here must exist at a real
// offset in the guest's `wire.ts` — and adding one means re-checking
// `kNodeRecordBytes` / `kCameraRecordBytes` / `kLightRecordBytes` /
// `kMaterialRecordBytes`, which are the strides the tables are walked by.

/// The five submission verbs' `kind` argument and the two `op`s.
constexpr uint32_t kSubmitNode = 0;
constexpr uint32_t kSubmitCamera = 1;
constexpr uint32_t kSubmitLight = 2;
constexpr uint32_t kSubmitMaterial = 3;
constexpr uint32_t kSubmitRenderable = 4;
constexpr uint32_t kSubmitUpsert = 0;
constexpr uint32_t kSubmitRemove = 1;

class SceneMirror {
  public:
    /// "Is `resource_id` live and of kind `kind`?" — answered by whoever owns
    /// the resource table (the loader, through the adapter). The mirror asks
    /// instead of guessing, and refuses a renderable that points at nothing.
    using ResourceKindFn = std::function<bool(uint32_t resource_id, uint32_t kind)>;

    void set_resource_check(ResourceKindFn check) { resource_check_ = std::move(check); }

    /// "How many bones does this mesh resource's rig have?" — 0 when the
    /// resource has no skeleton, is not a mesh, or is not live. Asked of the
    /// loader, which is the only thing that has looked inside the mesh file; the
    /// mirror keeps no shadow copy of a fact it cannot verify. A bone batch is
    /// refused against this, so a pose sent to a static mesh is an error the
    /// guest hears about rather than a silent no-op.
    using BoneCountFn = std::function<uint32_t(uint32_t resource_id)>;
    void set_bone_count(BoneCountFn check) { bone_count_fn_ = std::move(check); }

    /// Where the mirror says why it refused. Optional, and deliberately the
    /// same shape as the loader's sink: a unit test that never sets it gets the
    /// errno and no prose, and the adapter wires it to its own log at link
    /// time. The mirror stays OGRE-free and session-free either way.
    using LogFn = std::function<void(const std::string &message)>;
    void set_log(LogFn log) { log_ = std::move(log); }

    // ── the guest-thread face ────────────────────────────────────────────
    int32_t upsert_node(uint32_t id, const SceneNode &record);
    int32_t remove_node(uint32_t id);
    int32_t upsert_camera(uint32_t id, const CameraRecord &record);
    int32_t remove_camera(uint32_t id);
    int32_t upsert_light(uint32_t id, const LightRecord &record);
    int32_t remove_light(uint32_t id);
    int32_t upsert_material(uint32_t id, const Material &record);
    int32_t remove_material(uint32_t id);
    int32_t upsert_renderable(uint32_t id, const Renderable &record);
    int32_t remove_renderable(uint32_t id);

    /// Apply one motion-table entry (chunk 4): copy the transform into the
    /// renderable's record and mark it dirty. Liveness is the only check — the
    /// mesh and material were validated when the renderable was submitted, and
    /// a live entry's references are already known good, so re-validating them
    /// every frame would be work for nobody. `-EINVAL` for an id outside the
    /// table, `-ENOENT` for one that is not live (there is nothing to move).
    int32_t apply_motion(uint32_t id, const MotionUpdate &update);

    /// Apply a whole bone batch at once (chunk 5b). Every entry is validated
    /// against the mirror's own tables and the loader's rig knowledge before any
    /// of it lands, because a batch is one frame's pose: a half-applied pose
    /// would be a rig bent to a shape nobody asked for. `-EINVAL` or `-ENOENT`
    /// naming the index and the field on the first bad entry, nothing applied;
    /// `0` on success, with the batch copied and the generation bumped. The
    /// generation advances even when the batch repeats the previous one — the
    /// caller decides whether to re-apply, the mirror only records that a new
    /// snapshot arrived.
    int32_t apply_bones(const BoneUpdate *updates, uint32_t count);

    /// The pose snapshot, and a counter that changes when a new one lands. The
    /// render thread compares the counter against what it has already applied,
    /// so a still rig costs nothing.
    const BoneUpdate *bone_updates() const { return bones_.data(); }
    uint32_t bone_update_count() const { return bone_count_; }
    uint32_t bone_generation() const { return bone_generation_; }
    /// Bumped by every `set_skin_matrices`, so the render thread re-reads the
    /// map only when a guest actually sent something (the bone path's shape).
    uint32_t skin_generation() const { return skin_generation_; }

    // ── the guest's skin matrices (chunk 19 round 19b) ───────────────────
    //
    // Not a table: a rig's matrices are variable-length, so they are a map keyed
    // by renderable id instead. Written by `submit_skin_matrices` on the guest
    // thread under this mirror's lock; read by the render thread's apply, which
    // copies them into the Hlms that draws the rig. Removing a renderable drops
    // them, so an id reused later starts with no matrices rather than the last
    // occupant's.
    void set_skin_matrices(uint32_t id, const std::vector<float> &matrices);
    const std::vector<float> *skin_matrices(uint32_t id) const;

    // ── decoders: a record out of a guest-written region (no OGRE) ───────
    static bool decode_node(const uint8_t *region, size_t len, uint32_t id, SceneNode &out);
    static bool decode_camera(const uint8_t *region, size_t len, uint32_t id, CameraRecord &out);
    static bool decode_light(const uint8_t *region, size_t len, uint32_t id, LightRecord &out);
    static bool decode_material(const uint8_t *region, size_t len, uint32_t id,
                                Material &out);
    static bool decode_renderable(const uint8_t *region, size_t len, uint32_t id,
                                  Renderable &out);
    /// One motion-table entry, out of the table the guest wrote in `BUFFER_POOL`.
    static bool decode_motion_at(const uint8_t *record, MotionUpdate &out);
    /// One bone-table entry, out of the table past the motion table.
    static bool decode_bone_at(const uint8_t *record, BoneUpdate &out);

    /// The same decoders for one record already in host memory (the submit
    /// verb copies a single record out of the region before decoding it).
    static bool decode_node_at(const uint8_t *record, SceneNode &out);
    static bool decode_camera_at(const uint8_t *record, CameraRecord &out);
    static bool decode_light_at(const uint8_t *record, LightRecord &out);
    static bool decode_material_at(const uint8_t *record, Material &out);
    static bool decode_renderable_at(const uint8_t *record, Renderable &out);

    // ── the render thread's face (3b-ii reads these) ─────────────────────
    const std::vector<uint32_t> &dirty_nodes() const { return dirty_nodes_; }
    const std::vector<uint32_t> &dirty_cameras() const { return dirty_cameras_; }
    const std::vector<uint32_t> &dirty_lights() const { return dirty_lights_; }
    const std::vector<uint32_t> &dirty_materials() const { return dirty_materials_; }
    const std::vector<uint32_t> &dirty_renderables() const { return dirty_renderables_; }
    void clear_dirty();

    bool node_live(uint32_t id) const;
    /// How many live nodes name `id` as their parent. Derived, never stored.
    uint32_t child_count(uint32_t id) const;
    /// The lowest-numbered live child of `id`, or 0 when there is none — the id
    /// a refusal names.
    uint32_t first_child(uint32_t id) const;
    /// The lowest-numbered live renderable that hangs from `id`, or 0. A node a
    /// drawable is attached to cannot be removed any more than a node with
    /// children can: a live drawable with no node is unattached, which is a
    /// state the renderer has no sensible meaning for.
    uint32_t first_renderable_on(uint32_t node_id) const;
    /// The number of links from `id` up to the root (0 for a root node).
    uint32_t node_depth(uint32_t id) const;
    /// The height of the subtree under `id`, or `kMaxNodeDepth + 1` when the
    /// walk passes the cap — the number a re-parent is checked against.
    uint32_t subtree_height(uint32_t id) const;
    bool camera_live(uint32_t id) const;
    bool light_live(uint32_t id) const;
    bool material_live(uint32_t id) const;
    bool renderable_live(uint32_t id) const;
    const SceneNode *node(uint32_t id) const;
    const CameraRecord *camera(uint32_t id) const;
    const Material *material(uint32_t id) const;
    const Renderable *renderable(uint32_t id) const;
    const LightRecord *light(uint32_t id) const;
    size_t live_count() const;

  private:
    struct NodeEntry { bool live = false; SceneNode rec; };
    struct CameraEntry { bool live = false; CameraRecord rec; };
    struct LightEntry { bool live = false; LightRecord rec; };
    struct MaterialEntry { bool live = false; Material rec; };
    struct RenderableEntry { bool live = false; Renderable rec; };

    static void mark(std::vector<uint32_t> &list, uint32_t id);
    void note(const std::string &message) const {
        if (log_) log_(message);
    }

    LogFn log_;

    std::vector<NodeEntry> nodes_{kNodeCapacity};
    std::vector<CameraEntry> cameras_{kCameraCapacity};
    std::vector<LightEntry> lights_{kLightCapacity};
    std::vector<MaterialEntry> materials_{kMaterialCapacity};
    std::vector<RenderableEntry> renderables_{kRenderableCapacity};
    std::vector<uint32_t> dirty_nodes_, dirty_cameras_, dirty_lights_, dirty_materials_,
        dirty_renderables_;
    ResourceKindFn resource_check_;
    BoneCountFn bone_count_fn_;
    std::vector<BoneUpdate> bones_{kBoneCapacity};
    uint32_t bone_count_ = 0;
    uint32_t bone_generation_ = 0;
    uint32_t skin_generation_ = 0;
    std::unordered_map<uint32_t, std::vector<float>> skin_matrices_;
};

} // namespace tension_ogre

#endif // TENSION_OGRE_SCENE_H
