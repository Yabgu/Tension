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

uint32_t u32(const uint8_t *region, uint32_t offset) {
    return static_cast<uint32_t>(region[offset]) | (static_cast<uint32_t>(region[offset + 1]) << 8) |
           (static_cast<uint32_t>(region[offset + 2]) << 16) |
           (static_cast<uint32_t>(region[offset + 3]) << 24);
}

float f32(const uint8_t *region, uint32_t offset) {
    const uint32_t bits = u32(region, offset);
    float value = 0.0f;
    std::memcpy(&value, &bits, sizeof(value));
    return value;
}

/// The first four floats of a transform triple, for the records that carry one.
void read_transform(const uint8_t *r, uint32_t position_at, uint32_t rotation_at, uint32_t scale_at,
                    float &px, float &py, float &pz, float &rx, float &ry, float &rz, float &rw,
                    float &sx, float &sy, float &sz) {
    px = f32(r, position_at);
    py = f32(r, position_at + 4);
    pz = f32(r, position_at + 8);
    rx = f32(r, rotation_at);
    ry = f32(r, rotation_at + 4);
    rz = f32(r, rotation_at + 8);
    rw = f32(r, rotation_at + 12);
    sx = f32(r, scale_at);
    sy = f32(r, scale_at + 4);
    sz = f32(r, scale_at + 8);
}

} // namespace

void SceneMirror::mark(std::vector<uint32_t> &list, uint32_t id) {
    for (uint32_t existing : list) {
        if (existing == id) return;
    }
    list.push_back(id);
}

// ── upserts ─────────────────────────────────────────────────────────────

int32_t SceneMirror::upsert_node(uint32_t id, const SceneNodeRecord &record) {
    if (id == 0 || id > kNodeCapacity) return -EINVAL; // ids are 1-based
    // Flat nodes in 3b: parent/child composition waits for the chunk that
    // needs it, and a silently ignored parentId would be worse than a refusal.
    if (record.parent_id != 0) return -EINVAL;
    nodes_[id - 1].live = true;
    nodes_[id - 1].rec = record;
    nodes_[id - 1].rec.node_id = id;
    mark(dirty_nodes_, id);
    return 0;
}

int32_t SceneMirror::remove_node(uint32_t id) {
    if (id == 0 || id > kNodeCapacity) return -EINVAL;
    // No camera or light references a node in 3b — both carry their own
    // transform — so nothing can be holding this node. When a record grows a
    // node reference, this is where the -EBUSY belongs.
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

int32_t SceneMirror::upsert_material(uint32_t id, const MaterialRecord &record) {
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

int32_t SceneMirror::upsert_renderable(uint32_t id, const RenderableRecord &record) {
    if (id == 0 || id > kRenderableCapacity) return -EINVAL;
    if (record.material_id == 0 || record.material_id > kMaterialCapacity) return -EINVAL;
    if (!materials_[record.material_id - 1].live) return -EINVAL;
    if (record.mesh_resource_id == 0) return -EINVAL;
    if (resource_check_ && !resource_check_(record.mesh_resource_id, TENSION_OGRE_RES_KIND_MESH)) {
        return -EINVAL; // a renderable whose mesh never loaded is a guest bug
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
    mark(dirty_renderables_, id);
    return 0;
}

// ── decoders ────────────────────────────────────────────────────────────
//
// Two forms of each: `_at` decodes one record already in host memory (what the
// submit verb copies out of a region), and the region form bounds-checks the
// id against a table before calling it.

bool SceneMirror::decode_node_at(const uint8_t *r, SceneNodeRecord &out) {
    if (r == nullptr) return false;
    out = SceneNodeRecord{};
    out.node_id = u32(r, 0);
    out.parent_id = u32(r, 4);
    out.flags = u32(r, 8);
    out.child_count = u32(r, 12);
    out.name_offset = u32(r, 16);
    out.name_length = u32(r, 20);
    read_transform(r, 24, 40, 56, out.px, out.py, out.pz, out.rx, out.ry, out.rz, out.rw, out.sx,
                   out.sy, out.sz);
    return true;
}

bool SceneMirror::decode_camera_at(const uint8_t *r, CameraRecord &out) {
    if (r == nullptr) return false;
    out = CameraRecord{};
    out.camera_id = u32(r, 0);
    out.flags = u32(r, 4);
    out.fov_y = f32(r, 8);
    out.aspect = f32(r, 12);
    out.near_clip = f32(r, 16);
    out.far_clip = f32(r, 20);
    out.px = f32(r, 24);
    out.py = f32(r, 28);
    out.pz = f32(r, 32);
    out.rx = f32(r, 40);
    out.ry = f32(r, 44);
    out.rz = f32(r, 48);
    out.rw = f32(r, 52);
    out.viewport_width = u32(r, 56);
    out.viewport_height = u32(r, 60);
    return true;
}

bool SceneMirror::decode_light_at(const uint8_t *r, LightRecord &out) {
    if (r == nullptr) return false;
    out = LightRecord{};
    out.light_id = u32(r, 0);
    out.kind = u32(r, 4);
    out.flags = u32(r, 8);
    out.r = f32(r, 16);
    out.g = f32(r, 20);
    out.b = f32(r, 24);
    out.a = f32(r, 28);
    out.intensity = f32(r, 32);
    out.range = f32(r, 36);
    out.spot_inner = f32(r, 40);
    out.spot_outer = f32(r, 44);
    out.dx = f32(r, 48);
    out.dy = f32(r, 52);
    out.dz = f32(r, 56);
    out.px = f32(r, 64);
    out.py = f32(r, 68);
    out.pz = f32(r, 72);
    return true;
}

bool SceneMirror::decode_material_at(const uint8_t *r, MaterialRecord &out) {
    if (r == nullptr) return false;
    out = MaterialRecord{};
    out.material_id = u32(r, 0);
    out.kind = u32(r, 4);
    out.flags = u32(r, 8);
    out.dr = f32(r, 16);
    out.dg = f32(r, 20);
    out.db = f32(r, 24);
    out.da = f32(r, 28);
    out.sr = f32(r, 32);
    out.sg = f32(r, 36);
    out.sb = f32(r, 40);
    out.sa = f32(r, 44);
    out.er = f32(r, 48);
    out.eg = f32(r, 52);
    out.eb = f32(r, 56);
    out.ea = f32(r, 60);
    out.roughness = f32(r, 64);
    out.metalness = f32(r, 68);
    out.opacity = f32(r, 72);
    out.slot0_resource = u32(r, 80);
    out.slot0_sampler = u32(r, 84);
    out.slot0_flags = u32(r, 88);
    out.slot0_uv = u32(r, 92);
    return true;
}

bool SceneMirror::decode_renderable_at(const uint8_t *r, RenderableRecord &out) {
    if (r == nullptr) return false;
    out = RenderableRecord{};
    out.renderable_id = u32(r, 0);
    out.material_id = u32(r, 4);
    out.mesh_resource_id = u32(r, 8);
    out.flags = u32(r, 12);
    read_transform(r, 16, 32, 48, out.px, out.py, out.pz, out.rx, out.ry, out.rz, out.rw, out.sx,
                   out.sy, out.sz);
    return true;
}

bool SceneMirror::decode_node(const uint8_t *region, size_t len, uint32_t id, SceneNodeRecord &out) {
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
                                  MaterialRecord &out) {
    if (region == nullptr || id == 0 || id > kMaterialCapacity) return false;
    const uint32_t at = (id - 1) * kMaterialRecordBytes;
    if (!has(len, at, kMaterialRecordBytes)) return false;
    return decode_material_at(region + at, out);
}

bool SceneMirror::decode_renderable(const uint8_t *region, size_t len, uint32_t id,
                                    RenderableRecord &out) {
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

const SceneNodeRecord *SceneMirror::node(uint32_t id) const {
    return node_live(id) ? &nodes_[id - 1].rec : nullptr;
}
const CameraRecord *SceneMirror::camera(uint32_t id) const {
    return camera_live(id) ? &cameras_[id - 1].rec : nullptr;
}
const LightRecord *SceneMirror::light(uint32_t id) const {
    return light_live(id) ? &lights_[id - 1].rec : nullptr;
}
const MaterialRecord *SceneMirror::material(uint32_t id) const {
    return material_live(id) ? &materials_[id - 1].rec : nullptr;
}
const RenderableRecord *SceneMirror::renderable(uint32_t id) const {
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
