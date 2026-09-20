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
// MATERIAL is 64 KiB of 208-byte records, RENDERABLE 128 KiB of 64-byte ones.

#ifndef TENSION_OGRE_SCENE_H
#define TENSION_OGRE_SCENE_H

#include <cstddef>
#include <cstdint>
#include <functional>
#include <vector>

#include "../include/tension_ogre.h"

namespace tension_ogre {

/// Capacities, from the region sizes and the record sizes.
constexpr uint32_t kNodeCapacity = 1024;
constexpr uint32_t kCameraCapacity = 512;
constexpr uint32_t kLightCapacity = 1024;
constexpr uint32_t kMaterialCapacity = 256;
constexpr uint32_t kRenderableCapacity = 2048;

constexpr uint32_t kNodeRecordBytes = 80;
constexpr uint32_t kCameraRecordBytes = 80;
constexpr uint32_t kLightRecordBytes = 96;
constexpr uint32_t kMaterialRecordBytes = 208;
constexpr uint32_t kRenderableRecordBytes = 64;

/// SCENE's internal split: nodes, then cameras, then lights, end to end.
constexpr uint32_t kCameraTableOffset = kNodeCapacity * kNodeRecordBytes;
constexpr uint32_t kLightTableOffset = kCameraTableOffset + kCameraCapacity * kCameraRecordBytes;

/// The five decoded records — field for field what `wire.ts` lays out.
struct SceneNodeRecord {
    uint32_t node_id = 0, parent_id = 0, flags = 0, child_count = 0;
    uint32_t name_offset = 0, name_length = 0;
    float px = 0, py = 0, pz = 0, rx = 0, ry = 0, rz = 0, rw = 1, sx = 1, sy = 1, sz = 1;
};

struct CameraRecord {
    uint32_t camera_id = 0, flags = 0;
    float fov_y = 0, aspect = 0, near_clip = 0, far_clip = 0;
    float px = 0, py = 0, pz = 0, rx = 0, ry = 0, rz = 0, rw = 1;
    uint32_t viewport_width = 0, viewport_height = 0;
};

struct LightRecord {
    uint32_t light_id = 0, kind = 0, flags = 0;
    float r = 1, g = 1, b = 1, a = 1, intensity = 1, range = 0, spot_inner = 0, spot_outer = 0;
    float dx = 0, dy = 0, dz = 0, px = 0, py = 0, pz = 0;
};

struct MaterialRecord {
    uint32_t material_id = 0, kind = 0, flags = 0;
    float dr = 1, dg = 1, db = 1, da = 1;
    float sr = 0, sg = 0, sb = 0, sa = 0;
    float er = 0, eg = 0, eb = 0, ea = 0;
    float roughness = 0, metalness = 0, opacity = 1;
    uint32_t slot0_resource = 0, slot0_sampler = 0, slot0_flags = 0, slot0_uv = 0;
};

struct RenderableRecord {
    uint32_t renderable_id = 0, material_id = 0, mesh_resource_id = 0, flags = 0;
    float px = 0, py = 0, pz = 0, rx = 0, ry = 0, rz = 0, rw = 1, sx = 1, sy = 1, sz = 1;
};

/// One entry of the motion table (`wire.ts`'s `MotionUpdate`, 64 bytes) — a
/// renderable's whole transform and nothing else (chunk 4). The transform sits
/// at the same offsets `Renderable`'s inline one does, so the two read alike.
struct MotionUpdate {
    uint32_t renderable_id = 0, flags = 0;
    float px = 0, py = 0, pz = 0;
    float rx = 0, ry = 0, rz = 0, rw = 1;
    float sx = 1, sy = 1, sz = 1;
};

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

    // ── the guest-thread face ────────────────────────────────────────────
    int32_t upsert_node(uint32_t id, const SceneNodeRecord &record);
    int32_t remove_node(uint32_t id);
    int32_t upsert_camera(uint32_t id, const CameraRecord &record);
    int32_t remove_camera(uint32_t id);
    int32_t upsert_light(uint32_t id, const LightRecord &record);
    int32_t remove_light(uint32_t id);
    int32_t upsert_material(uint32_t id, const MaterialRecord &record);
    int32_t remove_material(uint32_t id);
    int32_t upsert_renderable(uint32_t id, const RenderableRecord &record);
    int32_t remove_renderable(uint32_t id);

    /// Apply one motion-table entry (chunk 4): copy the transform into the
    /// renderable's record and mark it dirty. Liveness is the only check — the
    /// mesh and material were validated when the renderable was submitted, and
    /// a live entry's references are already known good, so re-validating them
    /// every frame would be work for nobody. `-EINVAL` for an id outside the
    /// table, `-ENOENT` for one that is not live (there is nothing to move).
    int32_t apply_motion(uint32_t id, const MotionUpdate &update);

    // ── decoders: a record out of a guest-written region (no OGRE) ───────
    static bool decode_node(const uint8_t *region, size_t len, uint32_t id, SceneNodeRecord &out);
    static bool decode_camera(const uint8_t *region, size_t len, uint32_t id, CameraRecord &out);
    static bool decode_light(const uint8_t *region, size_t len, uint32_t id, LightRecord &out);
    static bool decode_material(const uint8_t *region, size_t len, uint32_t id,
                                MaterialRecord &out);
    static bool decode_renderable(const uint8_t *region, size_t len, uint32_t id,
                                  RenderableRecord &out);

    /// The same decoders for one record already in host memory (the submit
    /// verb copies a single record out of the region before decoding it).
    static bool decode_node_at(const uint8_t *record, SceneNodeRecord &out);
    static bool decode_camera_at(const uint8_t *record, CameraRecord &out);
    static bool decode_light_at(const uint8_t *record, LightRecord &out);
    static bool decode_material_at(const uint8_t *record, MaterialRecord &out);
    static bool decode_renderable_at(const uint8_t *record, RenderableRecord &out);

    // ── the render thread's face (3b-ii reads these) ─────────────────────
    const std::vector<uint32_t> &dirty_nodes() const { return dirty_nodes_; }
    const std::vector<uint32_t> &dirty_cameras() const { return dirty_cameras_; }
    const std::vector<uint32_t> &dirty_lights() const { return dirty_lights_; }
    const std::vector<uint32_t> &dirty_materials() const { return dirty_materials_; }
    const std::vector<uint32_t> &dirty_renderables() const { return dirty_renderables_; }
    void clear_dirty();

    bool node_live(uint32_t id) const;
    bool camera_live(uint32_t id) const;
    bool light_live(uint32_t id) const;
    bool material_live(uint32_t id) const;
    bool renderable_live(uint32_t id) const;
    const SceneNodeRecord *node(uint32_t id) const;
    const CameraRecord *camera(uint32_t id) const;
    const MaterialRecord *material(uint32_t id) const;
    const RenderableRecord *renderable(uint32_t id) const;
    const LightRecord *light(uint32_t id) const;
    size_t live_count() const;

  private:
    struct NodeEntry { bool live = false; SceneNodeRecord rec; };
    struct CameraEntry { bool live = false; CameraRecord rec; };
    struct LightEntry { bool live = false; LightRecord rec; };
    struct MaterialEntry { bool live = false; MaterialRecord rec; };
    struct RenderableEntry { bool live = false; RenderableRecord rec; };

    static void mark(std::vector<uint32_t> &list, uint32_t id);

    std::vector<NodeEntry> nodes_{kNodeCapacity};
    std::vector<CameraEntry> cameras_{kCameraCapacity};
    std::vector<LightEntry> lights_{kLightCapacity};
    std::vector<MaterialEntry> materials_{kMaterialCapacity};
    std::vector<RenderableEntry> renderables_{kRenderableCapacity};
    std::vector<uint32_t> dirty_nodes_, dirty_cameras_, dirty_lights_, dirty_materials_,
        dirty_renderables_;
    ResourceKindFn resource_check_;
};

} // namespace tension_ogre

#endif // TENSION_OGRE_SCENE_H
