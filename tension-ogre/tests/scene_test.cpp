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

// ── chunk 4: the motion table ───────────────────────────────────────────

/// A mirror holding one live renderable (id 1) that uses material 1 and mesh
/// resource 42, which is all a motion test needs to be true.
SceneMirror mirror_with_one_renderable() {
    SceneMirror mirror;
    MaterialRecord material;
    material.kind = TENSION_OGRE_MAT_HLMS_UNLIT;
    mirror.upsert_material(1, material);
    mirror.set_resource_check([](uint32_t id, uint32_t kind) {
        return kind == TENSION_OGRE_RES_KIND_MESH && id == 42;
    });
    mirror.upsert_renderable(1, renderable_using(1, 42));
    mirror.clear_dirty();
    return mirror;
}

MotionUpdate motion_at(float x, float y, float z) {
    MotionUpdate update;
    update.px = x;
    update.py = y;
    update.pz = z;
    update.rw = 1.0f;
    update.sx = update.sy = update.sz = 1.0f;
    return update;
}

void test_apply_motion_updates_transform_and_marks_dirty() {
    std::printf("test_apply_motion_updates_transform_and_marks_dirty\n");
    SceneMirror mirror = mirror_with_one_renderable();
    check_eq(mirror.apply_motion(1, motion_at(0.25f, -0.5f, 0.0f)), 0, "a live renderable moves");
    check(listed(mirror.dirty_renderables(), 1), "and is marked dirty for the render thread");
    const RenderableRecord *record = mirror.renderable(1);
    check(record != nullptr, "the record is still there");
    if (record != nullptr) {
        check(record->px > 0.249f && record->px < 0.251f, "x landed in the record");
        check(record->py > -0.501f && record->py < -0.499f, "y landed in the record");
        check(record->pz > -0.001f && record->pz < 0.001f, "z landed in the record");
    }
    // A second motion in the same epoch must not double-list the id: the dirty
    // list is what the render thread walks, and a guest stepping at 60 Hz is
    // the normal case, not the exception.
    check_eq(mirror.apply_motion(1, motion_at(0.5f, 0.0f, 0.0f)), 0, "a second motion applies");
    size_t occurrences = 0;
    for (uint32_t id : mirror.dirty_renderables()) {
        if (id == 1) ++occurrences;
    }
    check_eq(static_cast<int64_t>(occurrences), 1, "the id is listed once, not once per motion");
}

void test_apply_motion_unknown_id_returns_enoent() {
    std::printf("test_apply_motion_unknown_id_returns_enoent\n");
    SceneMirror mirror = mirror_with_one_renderable();
    check_eq(mirror.apply_motion(2, motion_at(1.0f, 0.0f, 0.0f)), -ENOENT,
             "a renderable that was never submitted cannot be moved");
    check(!listed(mirror.dirty_renderables(), 2), "and lists nothing");
    mirror.remove_renderable(1);
    check_eq(mirror.apply_motion(1, motion_at(1.0f, 0.0f, 0.0f)), -ENOENT,
             "nor can a removed one");
    check_eq(mirror.apply_motion(0, motion_at(1.0f, 0.0f, 0.0f)), -EINVAL, "id 0 is never valid");
    check_eq(mirror.apply_motion(kRenderableCapacity + 1, motion_at(1.0f, 0.0f, 0.0f)), -EINVAL,
             "nor is an id past the table");
}

void test_apply_motion_leaves_material_and_mesh_untouched() {
    std::printf("test_apply_motion_leaves_material_and_mesh_untouched\n");
    SceneMirror mirror = mirror_with_one_renderable();
    MotionUpdate update = motion_at(-1.5f, 2.5f, 0.25f);
    update.rx = 0.0f;
    update.ry = 0.7071068f;
    update.rz = 0.0f;
    update.rw = 0.7071068f;
    update.sx = update.sy = update.sz = 0.5f;
    check_eq(mirror.apply_motion(1, update), 0, "the motion applies");
    const RenderableRecord *record = mirror.renderable(1);
    check(record != nullptr, "the record is there");
    if (record != nullptr) {
        // The three fields a motion must never disturb: a solver that moved a
        // body must not repoint it at another mesh or material.
        check_eq(record->material_id, 1, "the material reference is untouched");
        check_eq(record->mesh_resource_id, 42, "the mesh resource is untouched");
        check_eq(record->renderable_id, 1, "and the id is untouched");
        check(record->ry > 0.707f && record->ry < 0.708f, "the rotation landed");
        check(record->sx > 0.499f && record->sx < 0.501f, "the scale landed");
    }
    check(mirror.material_live(1), "the material is still live");
    check(mirror.renderable_live(1), "and so is the renderable");
}

void test_apply_motion_multiple_bodies() {
    std::printf("test_apply_motion_multiple_bodies\n");
    SceneMirror mirror = mirror_with_one_renderable();
    const uint32_t bodies = 8;
    for (uint32_t id = 1; id <= bodies; ++id) {
        check_eq(mirror.upsert_renderable(id, renderable_using(1, 42)), 0, "a body is submitted");
    }
    mirror.clear_dirty();
    for (uint32_t id = 1; id <= bodies; ++id) {
        check_eq(mirror.apply_motion(id, motion_at(static_cast<float>(id) * 0.25f, 0.0f, 0.0f)), 0,
                 "each body moves");
    }
    check_eq(static_cast<int64_t>(mirror.dirty_renderables().size()), static_cast<int64_t>(bodies),
             "every body is dirty once");
    for (uint32_t id = 1; id <= bodies; ++id) {
        const RenderableRecord *record = mirror.renderable(id);
        const float want = static_cast<float>(id) * 0.25f;
        check(record != nullptr && record->px > want - 0.001f && record->px < want + 0.001f,
              "each body landed at its own x");
    }
}

void test_apply_motion_sequence_of_frames() {
    std::printf("test_apply_motion_sequence_of_frames\n");
    SceneMirror mirror = mirror_with_one_renderable();
    // Sixty frames of one body moving +X at 0.5 units/s in 1/60 s steps: the
    // shape the chunk-4 acid test drives, at the mirror's level.
    const float dt = 1.0f / 60.0f;
    const float velocity = 0.5f;
    for (int frame = 0; frame < 60; ++frame) {
        const float x = velocity * dt * static_cast<float>(frame);
        check_eq(mirror.apply_motion(1, motion_at(x, 0.0f, 0.0f)), 0, "the frame's motion applies");
        check(listed(mirror.dirty_renderables(), 1), "the frame is dirty");
        const RenderableRecord *record = mirror.renderable(1);
        check(record != nullptr && record->px > x - 0.0001f && record->px < x + 0.0001f,
              "this frame's x landed");
        mirror.clear_dirty();
        check(mirror.dirty_renderables().empty(), "and the list is clear for the next frame");
    }
    const RenderableRecord *record = mirror.renderable(1);
    check(record != nullptr && record->px > 0.4916f && record->px < 0.4917f,
          "after sixty frames the body is where 59 steps of the solver put it");
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
    test_apply_motion_updates_transform_and_marks_dirty();
    test_apply_motion_unknown_id_returns_enoent();
    test_apply_motion_leaves_material_and_mesh_untouched();
    test_apply_motion_multiple_bodies();
    test_apply_motion_sequence_of_frames();
    test_decode_node_bounds_check();
    test_decode_record_fields_land_where_wire_says();
    std::printf("%d checks, %d failures\n", checks, failures);
    return failures == 0 ? 0 : 1;
}
