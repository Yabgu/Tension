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

/// Decode a record whose wire size is larger than the host-side struct.
///
/// The host keeps the prefix it understands and refuses any non-zero bytes in the
/// record tail. That preserves the intended prefix decode while preventing silent
/// drift: a longer wire record with stale or malicious tail data is rejected
/// instead of being silently ignored.
template <typename T>
bool decode_prefix(const uint8_t *record, T &out, uint32_t wire_size) {
    if (record == nullptr) return false;
    std::memset(&out, 0, sizeof(out));
    std::memcpy(&out, record, sizeof(out));

    constexpr uint32_t host_size = static_cast<uint32_t>(sizeof(T));
    static_assert(host_size <= 64 || host_size <= 200, "unexpected host record size");

    if (wire_size <= host_size) return true;
    for (uint32_t i = host_size; i < wire_size; ++i) {
        if (record[i] != 0) return false;
    }
    return true;
}

} // namespace

void SceneMirror::mark(std::vector<uint32_t> &list, uint32_t id) {
    for (uint32_t existing : list) {
        if (existing == id) return;
    }
    list.push_back(id);
}

// ... existing content unchanged ...

bool SceneMirror::decode_node_at(const uint8_t *r, SceneNodeRecord &out) {
    if (r == nullptr) return false;
    return decode_prefix(r, out, kNodeRecordBytes);
}

bool SceneMirror::decode_camera_at(const uint8_t *r, CameraRecord &out) {
    if (r == nullptr) return false;
    return decode_prefix(r, out, kCameraRecordBytes);
}

bool SceneMirror::decode_light_at(const uint8_t *r, LightRecord &out) {
    if (r == nullptr) return false;
    return decode_prefix(r, out, kLightRecordBytes);
}

bool SceneMirror::decode_material_at(const uint8_t *r, MaterialRecord &out) {
    if (r == nullptr) return false;
    return decode_prefix(r, out, kMaterialRecordBytes);
}

bool SceneMirror::decode_renderable_at(const uint8_t *r, RenderableRecord &out) {
    if (r == nullptr) return false;
    return decode_prefix(r, out, kRenderableRecordBytes);
}

bool SceneMirror::decode_motion_at(const uint8_t *r, MotionUpdate &out) {
    if (r == nullptr) return false;
    return decode_prefix(r, out, kMotionRecordBytes);
}

bool SceneMirror::decode_bone_at(const uint8_t *r, BoneUpdate &out) {
    if (r == nullptr) return false;
    return decode_prefix(r, out, kBoneRecordBytes);
}

// ... rest of file unchanged ...

} // namespace tension_ogre
