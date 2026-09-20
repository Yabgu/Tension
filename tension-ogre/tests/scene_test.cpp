// scene_test.cpp — the scene mirror's unit tests. No OGRE, no guest.

#include "../src/scene.h"

#include <cerrno>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

using namespace tension_ogre;

namespace {

int checks = 0, failures = 0;

void check(bool ok, const std::string &what) {
    ++checks;
    if (!ok) {
        ++failures;
        std::printf("  FAIL %s\n", what.c_str());
    }
}

void check_eq(int64_t got, int64_t want, const std::string &what) {
    ++checks;
    if (got != want) {
        ++failures;
        std::printf("  FAIL %s: got %lld, want %lld\n", what.c_str(), (long long)got,
                    (long long)want);
    }
}

bool listed(const std::vector<uint32_t> &list, uint32_t id) {
    for (uint32_t entry : list) {
        if (entry == id) return true;
    }
    return false;
}

RenderableRecord renderable_using(uint32_t material, uint32_t mesh) {
    RenderableRecord renderable;
    renderable.material_id = material;
    renderable.mesh_resource_id = mesh;
    renderable.sx = renderable.sy = renderable.sz = 1.0f;
    renderable.rw = 1.0f;
    return renderable;
}

void test_upsert_node_marks_dirty() {
    std::printf("test_upsert_node_marks_dirty\n");
    SceneMirror mirror;
    SceneNodeRecord node;
    check_eq(mirror.upsert_node(1, node), 0, "a flat node is accepted");
    check(listed(mirror.dirty_nodes(), 1), "and is marked dirty");
    check(mirror.node_live(1), "and is live");
    mirror.clear_dirty();
    check(mirror.dirty_nodes().empty(), "clear_dirty empties the list");
    check(mirror.node_live(1), "without unliving the entry");
}

void test_upsert_node_with_parent_refused() {
    std::printf("test_upsert_node_with_parent_refused\n");
    SceneMirror mirror;
    SceneNodeRecord node;
    node.parent_id = 7;
    check_eq(mirror.upsert_node(1, node), -EINVAL, "a parent is refused in 3b");
    check(!mirror.node_live(1), "and nothing was stored");
    node.parent_id = 0;
    check_eq(mirror.upsert_node(0, node), -EINVAL, "id 0 is never valid");
    check_eq(mirror.upsert_node(kNodeCapacity + 1, node), -EINVAL, "past the table is refused");
}

void test_remove_node_clears_live_and_marks_dirty() {
    std::printf("test_remove_node_clears_live_and_marks_dirty\n");
    SceneMirror mirror;
    mirror.upsert_node(3, SceneNodeRecord{});
    mirror.clear_dirty();
    check_eq(mirror.remove_node(3), 0, "remove succeeds");
    check(!mirror.node_live(3), "the entry is no longer live");
    // Dirty, not clean: the render thread still has an OGRE node to destroy.
    check(listed(mirror.dirty_nodes(), 3), "the removal is marked dirty for the render thread");
}

void test_upsert_renderable_validates_material_live() {
    std::printf("test_upsert_renderable_validates_material_live\n");
    SceneMirror mirror;
    check_eq(mirror.upsert_renderable(1, renderable_using(1, 1)), -EINVAL,
             "a renderable with no material is refused");
    MaterialRecord material;
    material.kind = TENSION_OGRE_MAT_HLMS_UNLIT;
    check_eq(mirror.upsert_material(1, material), 0, "the material is accepted");
    check_eq(mirror.upsert_renderable(1, renderable_using(1, 1)), 0,
             "and then the renderable is too");
    check(mirror.renderable_live(1), "the renderable is live");
}

void test_upsert_renderable_validates_mesh_resource_kind() {
    std::printf("test_upsert_renderable_validates_mesh_resource_kind\n");
    SceneMirror mirror;
    MaterialRecord material;
    material.kind = TENSION_OGRE_MAT_HLMS_UNLIT;
    mirror.upsert_material(1, material);

    // The resource check belongs to whoever owns the table: here, a stand-in.
    std::vector<uint32_t> mesh_ids = {42};
    mirror.set_resource_check([&mesh_ids](uint32_t id, uint32_t kind) {
        if (kind != TENSION_OGRE_RES_KIND_MESH) return false;
        for (uint32_t mesh : mesh_ids) {
            if (mesh == id) return true;
        }
        return false;
    });
    check_eq(mirror.upsert_renderable(1, renderable_using(1, 42)), 0, "a live mesh is accepted");
    check_eq(mirror.upsert_renderable(2, renderable_using(1, 43)), -EINVAL,
             "a resource that is not a live mesh is refused");
    check_eq(mirror.upsert_renderable(3, renderable_using(1, 0)), -EINVAL, "and 0 is refused");
}

void test_remove_material_in_use_refused() {
    std::printf("test_remove_material_in_use_refused\n");
    SceneMirror mirror;
    MaterialRecord material;
    material.kind = TENSION_OGRE_MAT_HLMS_UNLIT;
    mirror.upsert_material(1, material);
    mirror.upsert_renderable(1, renderable_using(1, 1));
    check_eq(mirror.remove_material(1), -EBUSY, "a material an item holds is not destroyed");
    check(mirror.material_live(1), "so it stays live");
    check_eq(mirror.remove_renderable(1), 0, "drop the renderable");
    check_eq(mirror.remove_material(1), 0, "and then the material goes");
    check(!mirror.material_live(1), "it is gone");
}

void test_decode_node_bounds_check() {
    std::printf("test_decode_node_bounds_check\n");
    std::vector<uint8_t> region(kNodeRecordBytes * 2, 0);
    SceneNodeRecord node;
    check(SceneMirror::decode_node(region.data(), region.size(), 1, node), "slot 1 decodes");
    check(SceneMirror::decode_node(region.data(), region.size(), 2, node), "slot 2 decodes");
    check(!SceneMirror::decode_node(region.data(), region.size(), 3, node),
          "past the region is refused");
    check(!SceneMirror::decode_node(region.data(), region.size(), 0, node), "id 0 is refused");
    check(!SceneMirror::decode_node(nullptr, 0, 1, node), "a null region is refused");
    check(!SceneMirror::decode_node(region.data(), region.size() - 1, 2, node),
          "a truncated region is refused");
}

void test_decode_record_fields_land_where_wire_says() {
    std::printf("test_decode_record_fields_land_where_wire_says\n");
    std::vector<uint8_t> scene_region(kLightTableOffset + kLightRecordBytes, 0);
    auto put_u32 = [](std::vector<uint8_t> &b, size_t at, uint32_t v) {
        b[at] = uint8_t(v); b[at + 1] = uint8_t(v >> 8); b[at + 2] = uint8_t(v >> 16); b[at + 3] = uint8_t(v >> 24);
    };
    // A camera at id 1: fov 60 degrees, near 0.1, far 100, at (0, 0, 4).
    const size_t camera_at = kCameraTableOffset;
    put_u32(scene_region, camera_at + 8, 0x42700000);  // 60.0f
    put_u32(scene_region, camera_at + 16, 0x3DCCCCCD); // 0.1f
    put_u32(scene_region, camera_at + 20, 0x42C80000); // 100.0f
    put_u32(scene_region, camera_at + 32, 0x40800000); // 4.0f

    CameraRecord camera;
    check(SceneMirror::decode_camera(scene_region.data(), scene_region.size(), 1, camera),
          "the camera decodes");
    check(camera.fov_y > 59.9f && camera.fov_y < 60.1f, "fovY at offset 8");
    check(camera.near_clip > 0.09f && camera.near_clip < 0.11f, "near at 16");
    check(camera.far_clip > 99.9f && camera.far_clip < 100.1f, "far at 20");
    check(camera.pz > 3.9f && camera.pz < 4.1f, "position z at 32");

    // A camera id past the table is refused even when the region has room
    // (the light table's bytes are not a camera).
    check(!SceneMirror::decode_camera(scene_region.data(), scene_region.size(),
                                      kCameraCapacity + 1, camera),
          "past the camera table is refused");
}

} // namespace

int main() {
    std::setvbuf(stdout, nullptr, _IONBF, 0);
    test_upsert_node_marks_dirty();
    test_upsert_node_with_parent_refused();
    test_remove_node_clears_live_and_marks_dirty();
    test_upsert_renderable_validates_material_live();
    test_upsert_renderable_validates_mesh_resource_kind();
    test_remove_material_in_use_refused();
    test_decode_node_bounds_check();
    test_decode_record_fields_land_where_wire_says();
    std::printf("%d checks, %d failures\n", checks, failures);
    return failures == 0 ? 0 : 1;
}
