// The scene mirror — see scene.h for what it is and why it has no OGRE in it.

#include "scene.h"

#include <cerrno>
#include <cstring>

namespace tension_ogre {
namespace {

/// Bounds-checked readers over a guest-written region. A short region is a
/// refusal, never a partial read: the guest's table is the truth, and a
/// truncated one is a guest bug worth naming.
bool has(size_t len, uint32_t offset, uint32_t width) {
    return static_cast<size_t>(offset) + width <= len;
}

} // namespace

void SceneMirror::mark(std::vector<uint32_t> &list, uint32_t id) {
    for (uint32_t existing : list) {
        if (existing == id) return;
    }
    list.push_back(id);
}

// ── upserts ─────────────────────────────────────────────────────────────

int32_t SceneMirror::upsert_node(uint32_t id, const SceneNode &record) {
    if (id == 0 || id > kNodeCapacity) return -EINVAL; // ids are 1-based
    // The count is the mirror's answer, not the guest's claim. A guest that
    // fills it in is guessing at something this table already knows.
    if (record.child_count != 0) {
        note("node " + std::to_string(id) + " carries childCount " +
             std::to_string(record.child_count) + ", which the mirror derives from parentId");
        return -EINVAL;
    }
    uint32_t depth = 0;
    if (record.parent_id != 0) {
        if (record.parent_id > kNodeCapacity || !nodes_[record.parent_id - 1].live) {
            note("node " + std::to_string(id) + " names parent " +
                 std::to_string(record.parent_id) + ", which is not a live node");
            return -EINVAL;
        }
        // Walk the chain the proposal would create, from the proposed parent
        // up. Every live node's ancestors are live — removal refuses while a
        // child is live, so the invariant holds by construction — which is why
        // this walk can stop at 0 without checking liveness again.
        std::string chain;
        uint32_t at = record.parent_id;
        uint32_t links = 1;
        while (at != 0) {
            if (at == id) {
                note("node " + std::to_string(id) + " would be its own ancestor: " + chain +
                     std::to_string(at));
                return -EINVAL;
            }
            if (links > kMaxNodeDepth) {
                note("node " + std::to_string(id) + " would sit " + std::to_string(links) +
                     " links deep, past the cap of " + std::to_string(kMaxNodeDepth));
                return -EINVAL;
            }
            chain += std::to_string(at) + " <- ";
            at = nodes_[at - 1].rec.parent_id;
            ++links;
        }
        depth = links - 1; // the node's own depth once this lands
        // The subtree it carries moves with it, so the cap is on the deepest
        // chain the submission creates, not just on the node's own depth.
        const uint32_t height = subtree_height(id);
        if (depth + height > kMaxNodeDepth) {
            note("node " + std::to_string(id) + " at depth " + std::to_string(depth) +
                 " carries a subtree " + std::to_string(height) +
                 " deep, past the cap of " + std::to_string(kMaxNodeDepth));
            return -EINVAL;
        }
    }
    nodes_[id - 1].live = true;
    nodes_[id - 1].rec = record;
    nodes_[id - 1].rec.node_id = id;
    mark(dirty_nodes_, id);
    return 0;
}

uint32_t SceneMirror::child_count(uint32_t id) const {
    uint32_t count = 0;
    for (uint32_t candidate = 1; candidate <= kNodeCapacity; ++candidate) {
        if (nodes_[candidate - 1].live && nodes_[candidate - 1].rec.parent_id == id) ++count;
    }
    return count;
}

uint32_t SceneMirror::first_child(uint32_t id) const {
    for (uint32_t candidate = 1; candidate <= kNodeCapacity; ++candidate) {
        if (nodes_[candidate - 1].live && nodes_[candidate - 1].rec.parent_id == id) {
            return candidate;
        }
    }
    return 0;
}

uint32_t SceneMirror::first_renderable_on(uint32_t node_id) const {
    for (uint32_t candidate = 1; candidate <= kRenderableCapacity; ++candidate) {
        if (renderables_[candidate - 1].live && renderables_[candidate - 1].rec.node_id == node_id) {
            return candidate;
        }
    }
    return 0;
}

uint32_t SceneMirror::node_depth(uint32_t id) const {
    // Links, not nodes: a root is 0, its child is 1, and the cap reads as "no
    // node sits more than 32 links below the root".
    if (id == 0 || id > kNodeCapacity || !nodes_[id - 1].live) return 0;
    uint32_t depth = 0;
    uint32_t at = nodes_[id - 1].rec.parent_id;
    while (at != 0 && depth <= kMaxNodeDepth) {
        ++depth;
        if (!nodes_[at - 1].live) break;
        at = nodes_[at - 1].rec.parent_id;
    }
    return depth;
}

uint32_t SceneMirror::subtree_height(uint32_t id) const {
    uint32_t tallest = 0;
    for (uint32_t candidate = 1; candidate <= kNodeCapacity; ++candidate) {
        if (!nodes_[candidate - 1].live) continue;
        if (nodes_[candidate - 1].rec.parent_id != id) continue;
        const uint32_t below = 1 + subtree_height(candidate);
        if (below > tallest) tallest = below;
        if (tallest > kMaxNodeDepth) return tallest; // the walk is bounded too
    }
    return tallest;
}

int32_t SceneMirror::remove_node(uint32_t id) {
    if (id == 0 || id > kNodeCapacity) return -EINVAL;
    // A parent that dies under a live child is a dangling reference, and OGRE
    // would detach the child without saying so. The same is true of a node a
    // drawable hangs from: "alive but unattached" has no meaning the renderer
    // could act on, so both are refusals that name what is holding it.
    if (const uint32_t child = first_child(id)) {
        note("node " + std::to_string(id) + " still has live children, first " +
             std::to_string(child) + "; remove or re-parent them first");
        return -EBUSY;
    }
    if (const uint32_t drawable = first_renderable_on(id)) {
        note("renderable " + std::to_string(drawable) + " still hangs from node " +
             std::to_string(id) + "; remove it or move it first");
        return -EBUSY;
    }
    nodes_[id - 1].live = false;
    mark(dirty_nodes_, id);
    return 0;
}

int32_t SceneMirror::upsert_camera(uint32_t id, const CameraRecord &record) {
    if (id == 0 || id > kCameraCapacity) return -EINVAL;
    if (!(record.fov_y > 0.0f) || !(record.near_clip > 0.0f) || !(record.far_clip > record.near_clip)) {
        return -EINVAL; // a camera that cannot see is a guest bug worth naming
    }
    cameras_[id - 1].live = true;
    cameras_[id - 1].rec = record;
    cameras_[id - 1].rec.camera_id = id;
    mark(dirty_cameras_, id);
    return 0;
}

int32_t SceneMirror::remove_camera(uint32_t id) {
    if (id == 0 || id > kCameraCapacity) return -EINVAL;
    cameras_[id - 1].live = false;
    mark(dirty_cameras_, id);
    return 0;
}

int32_t SceneMirror::upsert_light(uint32_t id, const LightRecord &record) {
    if (id == 0 || id > kLightCapacity) return -EINVAL;
    if (record.kind > 2) return -EINVAL; // directional, point, spot
    lights_[id - 1].live = true;
    lights_[id - 1].rec = record;
    lights_[id - 1].rec.light_id = id;
    mark(dirty_lights_, id);
    return 0;
}

int32_t SceneMirror::remove_light(uint32_t id) {
    if (id == 0 || id > kLightCapacity) return -EINVAL;
    lights_[id - 1].live = false;
    mark(dirty_lights_, id);
    return 0;
}

int32_t SceneMirror::upsert_material(uint32_t id, const Material &record) {
    if (id == 0 || id > kMaterialCapacity) return -EINVAL;
    if (record.kind > TENSION_OGRE_MAT_HLMS_CUSTOM) return -EINVAL;
    materials_[id - 1].live = true;
    materials_[id - 1].rec = record;
    materials_[id - 1].rec.material_id = id;
    mark(dirty_materials_, id);
    return 0;
}

int32_t SceneMirror::remove_material(uint32_t id) {
    if (id == 0 || id > kMaterialCapacity) return -EINVAL;
    // A live renderable holds the datablock by name: destroying it under the
    // item is how a crash is built, so the refusal is the feature.
    for (const RenderableEntry &entry : renderables_) {
        if (entry.live && entry.rec.material_id == id) return -EBUSY;
    }
    materials_[id - 1].live = false;
    mark(dirty_materials_, id);
    return 0;
}

int32_t SceneMirror::upsert_renderable(uint32_t id, const Renderable &record) {
    if (id == 0 || id > kRenderableCapacity) return -EINVAL;
    if (record.material_id == 0 || record.material_id > kMaterialCapacity) return -EINVAL;
    if (!materials_[record.material_id - 1].live) return -EINVAL;
    if (record.mesh_resource_id == 0) return -EINVAL;
    if (resource_check_ && !resource_check_(record.mesh_resource_id, TENSION_OGRE_RES_KIND_MESH)) {
        return -EINVAL; // a renderable whose mesh never loaded is a guest bug
    }
    if (record.node_id != 0 &&
        (record.node_id > kNodeCapacity || !nodes_[record.node_id - 1].live)) {
        note("renderable " + std::to_string(id) + " names node " +
             std::to_string(record.node_id) + ", which is not a live node");
        return -EINVAL;
    }
    renderables_[id - 1].live = true;
    renderables_[id - 1].rec = record;
    renderables_[id - 1].rec.renderable_id = id;
    mark(dirty_renderables_, id);
    return 0;
}

int32_t SceneMirror::remove_renderable(uint32_t id) {
    if (id == 0 || id > kRenderableCapacity) return -EINVAL;
    renderables_[id - 1].live = false;
    // The matrices belonged to that renderable; an id reused later must not
    // inherit the last occupant's rig.
    skin_matrices_.erase(id);
    mark(dirty_renderables_, id);
    return 0;
}

void SceneMirror::set_skin_matrices(uint32_t id, const std::vector<float> &matrices) {
    if (id == 0 || id > kRenderableCapacity) return;
    skin_matrices_[id] = matrices;
    ++skin_generation_;
}

const std::vector<float> *SceneMirror::skin_matrices(uint32_t id) const {
    const auto itor = skin_matrices_.find(id);
    return itor == skin_matrices_.end() ? nullptr : &itor->second;
}

int32_t SceneMirror::apply_motion(uint32_t id, const MotionUpdate &update) {
    if (id == 0 || id > kRenderableCapacity) return -EINVAL;
    RenderableEntry &entry = renderables_[id - 1];
    // Not live means nothing was submitted at this id, so there is no OGRE
    // object to move and no record to move it for. The mesh and material
    // references a live entry holds were validated at submit time.
    if (!entry.live) return -ENOENT;
    entry.rec.position.x = update.position.x;
    entry.rec.position.y = update.position.y;
    entry.rec.position.z = update.position.z;
    entry.rec.rotation.x = update.rotation.x;
    entry.rec.rotation.y = update.rotation.y;
    entry.rec.rotation.z = update.rotation.z;
    entry.rec.rotation.w = update.rotation.w;
    entry.rec.scale.x = update.scale.x;
    entry.rec.scale.y = update.scale.y;
    entry.rec.scale.z = update.scale.z;
    mark(dirty_renderables_, id);
    return 0;
}

int32_t SceneMirror::apply_bones(const BoneUpdate *updates, uint32_t count) {
    if (updates == nullptr) return -EINVAL;
    if (count == 0 || count > kBoneCapacity) {
        note("bones: a batch of " + std::to_string(count) + " does not fit a table of " +
             std::to_string(kBoneCapacity));
        return -EINVAL;
    }
    // Validation first, over the whole batch, because validation and application
    // interleaved is how a batch ends up half-applied: the first bad entry would
    // arrive after some poses had already landed, and a rig bent to a shape
    // nobody asked for is worse than a refused frame.
    for (uint32_t i = 0; i < count; ++i) {
        const BoneUpdate &update = updates[i];
        if (update.renderable_id == 0 || update.renderable_id > kRenderableCapacity) {
            note("bones[" + std::to_string(i) + "]: renderableId " +
                 std::to_string(update.renderable_id) + " is outside the renderable table");
            return -EINVAL;
        }
        const RenderableEntry &entry = renderables_[update.renderable_id - 1];
        if (!entry.live) {
            note("bones[" + std::to_string(i) + "]: renderableId " +
                 std::to_string(update.renderable_id) + " is not live");
            return -ENOENT;
        }
        // The rig question belongs to the loader — it is the only thing that has
        // looked inside the mesh — and 0 bones is the honest answer for a static
        // mesh, an unloaded one, and a resource that is not a mesh at all.
        const uint32_t bones = bone_count_fn_ ? bone_count_fn_(entry.rec.mesh_resource_id) : 0;
        if (bones == 0) {
            note("bones[" + std::to_string(i) + "]: renderableId " +
                 std::to_string(update.renderable_id) + " names mesh resource " +
                 std::to_string(entry.rec.mesh_resource_id) + ", which has no skeleton");
            return -EINVAL;
        }
        if (update.bone_index >= bones) {
            note("bones[" + std::to_string(i) + "]: boneIndex " +
                 std::to_string(update.bone_index) + " is past the " + std::to_string(bones) +
                 " bones of mesh resource " + std::to_string(entry.rec.mesh_resource_id));
            return -EINVAL;
        }
    }
    for (uint32_t i = 0; i < count; ++i) bones_[i] = updates[i];
    bone_count_ = count;
    // The generation advances even when the batch repeats the last one. The
    // mirror records that a snapshot arrived; whether it is worth re-applying is
    // the render thread's question, and answering it here would mean the mirror
    // comparing batches it has no reason to keep.
    ++bone_generation_;
    return 0;
}

// ── decoders ────────────────────────────────────────────────────────────
//
// Two forms of each: `_at` decodes one record already in host memory (what the
// submit verb copies out of a region), and the region form bounds-checks the
// id against a table before calling it.

bool SceneMirror::decode_node_at(const uint8_t *r, SceneNode &out) {
    if (r == nullptr) return false;
    // One copy: the struct is the whole wire record (generated from
    // `schema/ogre.json`, with a static_assert per field), so its bytes *are*
    // the record's.
    std::memcpy(&out, r, sizeof(out));
    return true;
}

bool SceneMirror::decode_camera_at(const uint8_t *r, CameraRecord &out) {
    if (r == nullptr) return false;
    // One copy: the struct is the whole wire record (generated from
    // `schema/ogre.json`, with a static_assert per field), so its bytes *are*
    // the record's.
    std::memcpy(&out, r, sizeof(out));
    return true;
}

bool SceneMirror::decode_light_at(const uint8_t *r, LightRecord &out) {
    if (r == nullptr) return false;
    // One copy: the struct is the whole wire record (generated from
    // `schema/ogre.json`, with a static_assert per field), so its bytes *are*
    // the record's.
    std::memcpy(&out, r, sizeof(out));
    return true;
}

bool SceneMirror::decode_material_at(const uint8_t *r, Material &out) {
    if (r == nullptr) return false;
    // One copy: the struct is the whole wire record (generated from
    // `schema/ogre.json`, with a static_assert per field), so its bytes *are*
    // the record's.
    std::memcpy(&out, r, sizeof(out));
    return true;
}

bool SceneMirror::decode_renderable_at(const uint8_t *r, Renderable &out) {
    if (r == nullptr) return false;
    // Offset 12 is `node_id` (wire `nodeId`, since chunk 5a; it was
    // `flags` before that) — pinned in scene.h.
    // One copy: the struct is the whole wire record (generated from
    // `schema/ogre.json`, with a static_assert per field), so its bytes *are*
    // the record's.
    std::memcpy(&out, r, sizeof(out));
    return true;
}

bool SceneMirror::decode_motion_at(const uint8_t *r, MotionUpdate &out) {
    if (r == nullptr) return false;
    // The transform lands at 8/20/36, the same shape a Renderable's inline
    // one has, which is the point of the record.
    // One copy: the struct is the whole wire record (generated from
    // `schema/ogre.json`, with a static_assert per field), so its bytes *are*
    // the record's.
    std::memcpy(&out, r, sizeof(out));
    return true;
}

bool SceneMirror::decode_bone_at(const uint8_t *r, BoneUpdate &out) {
    if (r == nullptr) return false;
    // The motion record's transform offsets, for the motion record's reason:
    // one reading of a transform serves every record that carries one.
    // One copy: the struct is the whole wire record (generated from
    // `schema/ogre.json`, with a static_assert per field), so its bytes *are*
    // the record's.
    std::memcpy(&out, r, sizeof(out));
    return true;
}

bool SceneMirror::decode_node(const uint8_t *region, size_t len, uint32_t id, SceneNode &out) {
    if (region == nullptr || id == 0 || id > kNodeCapacity) return false;
    const uint32_t at = (id - 1) * kNodeRecordBytes;
    if (!has(len, at, kNodeRecordBytes)) return false;
    return decode_node_at(region + at, out);
}

bool SceneMirror::decode_camera(const uint8_t *region, size_t len, uint32_t id, CameraRecord &out) {
    if (region == nullptr || id == 0 || id > kCameraCapacity) return false;
    const uint32_t at = kCameraTableOffset + (id - 1) * kCameraRecordBytes;
    if (!has(len, at, kCameraRecordBytes)) return false;
    return decode_camera_at(region + at, out);
}

bool SceneMirror::decode_light(const uint8_t *region, size_t len, uint32_t id, LightRecord &out) {
    if (region == nullptr || id == 0 || id > kLightCapacity) return false;
    const uint32_t at = kLightTableOffset + (id - 1) * kLightRecordBytes;
    if (!has(len, at, kLightRecordBytes)) return false;
    return decode_light_at(region + at, out);
}

bool SceneMirror::decode_material(const uint8_t *region, size_t len, uint32_t id,
                                  Material &out) {
    if (region == nullptr || id == 0 || id > kMaterialCapacity) return false;
    const uint32_t at = (id - 1) * kMaterialRecordBytes;
    if (!has(len, at, kMaterialRecordBytes)) return false;
    return decode_material_at(region + at, out);
}

bool SceneMirror::decode_renderable(const uint8_t *region, size_t len, uint32_t id,
                                    Renderable &out) {
    if (region == nullptr || id == 0 || id > kRenderableCapacity) return false;
    const uint32_t at = (id - 1) * kRenderableRecordBytes;
    if (!has(len, at, kRenderableRecordBytes)) return false;
    return decode_renderable_at(region + at, out);
}

// ── the render thread's face ────────────────────────────────────────────

void SceneMirror::clear_dirty() {
    dirty_nodes_.clear();
    dirty_cameras_.clear();
    dirty_lights_.clear();
    dirty_materials_.clear();
    dirty_renderables_.clear();
}

bool SceneMirror::node_live(uint32_t id) const {
    return id != 0 && id <= kNodeCapacity && nodes_[id - 1].live;
}
bool SceneMirror::camera_live(uint32_t id) const {
    return id != 0 && id <= kCameraCapacity && cameras_[id - 1].live;
}
bool SceneMirror::light_live(uint32_t id) const {
    return id != 0 && id <= kLightCapacity && lights_[id - 1].live;
}
bool SceneMirror::material_live(uint32_t id) const {
    return id != 0 && id <= kMaterialCapacity && materials_[id - 1].live;
}
bool SceneMirror::renderable_live(uint32_t id) const {
    return id != 0 && id <= kRenderableCapacity && renderables_[id - 1].live;
}

const SceneNode *SceneMirror::node(uint32_t id) const {
    return node_live(id) ? &nodes_[id - 1].rec : nullptr;
}
const CameraRecord *SceneMirror::camera(uint32_t id) const {
    return camera_live(id) ? &cameras_[id - 1].rec : nullptr;
}
const LightRecord *SceneMirror::light(uint32_t id) const {
    return light_live(id) ? &lights_[id - 1].rec : nullptr;
}
const Material *SceneMirror::material(uint32_t id) const {
    return material_live(id) ? &materials_[id - 1].rec : nullptr;
}
const Renderable *SceneMirror::renderable(uint32_t id) const {
    return renderable_live(id) ? &renderables_[id - 1].rec : nullptr;
}

size_t SceneMirror::live_count() const {
    size_t total = 0;
    for (const NodeEntry &entry : nodes_) total += entry.live ? 1 : 0;
    for (const CameraEntry &entry : cameras_) total += entry.live ? 1 : 0;
    for (const LightEntry &entry : lights_) total += entry.live ? 1 : 0;
    for (const MaterialEntry &entry : materials_) total += entry.live ? 1 : 0;
    for (const RenderableEntry &entry : renderables_) total += entry.live ? 1 : 0;
    return total;
}

} // namespace tension_ogre
