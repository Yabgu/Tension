// probe_kenney.cpp — does the converted Kenney character load and skin under
// OGRE-Next? (chunk 12, round 12a)
//
// The conversion chain is FBX -> Blender 5.2.2 (io_ogre) -> .mesh.xml +
// .skeleton.xml -> OgreMeshTool -V 1.10 -> .mesh + .skeleton. This probe is
// the proof the chain's *output* is usable by this adapter's import path, and
// it is deliberately the 11a-probe recipe (manual skeleton registration, no
// resource locations, no disk fallback):
//
//   1. read both binaries off the disk,
//   2. `v1::OldSkeletonManager::create(name, group, isManual=true, loader)`
//      where the loader's loadResource() runs `v1::SkeletonSerializer::
//      importSkeleton` over the skeleton's bytes. The name must be exactly the
//      mesh's own `<skeletonlink>` reference — the 11a trap.
//   3. import the mesh the way `realise_mesh` does, and read the bone list,
//      the bounding box, and the rest pose out of OGRE.
//   4. render a rest frame, rotate `LeftForeArm` 45 degrees, render, and
//      measure the flip fraction; then the same for `Hips` at 15 degrees — a
//      forearm swing and a torso sway are two different silhouette changes,
//      and a rig that skinned only the second would pass a one-bone test.
//
// Build:
//   g++ -std=c++17 -O1 -isystem /usr/include/OGRE-Next \
//       -isystem /usr/include/OGRE-Next/Hlms/Common \
//       -isystem /usr/include/OGRE-Next/Hlms/Unlit \
//       -isystem /usr/include/OGRE-Next/Hlms/Pbs \
//       tests/probe_kenney.cpp -o build/probe-kenney/probe_kenney \
//       -lOgreNextMain -lOgreNextHlmsUnlit -lOgreNextHlmsPbs -lpthread
//
// Run:
//   ./probe_kenney /usr/lib/OGRE-Next <character.mesh> <character.skeleton>

#include <OgreArchiveManager.h>
#include <OgreCamera.h>
#include <OgreColourValue.h>
#include <OgreDataStream.h>
#include <OgreException.h>
#include <OgreFrameListener.h>
#include <OgreHlmsDatablock.h>
#include <OgreHlmsManager.h>
#include <OgreImage2.h>
#include <OgreItem.h>
#include <OgreLogManager.h>
#include <OgreMesh.h>
#include <OgreMesh2.h>
#include <OgreMeshManager.h>
#include <OgreMeshManager2.h>
#include <OgreMeshSerializer.h>
#include <OgreOldSkeletonManager.h>
#include <OgreRenderSystem.h>
#include <OgreResourceGroupManager.h>
#include <OgreResource.h>
#include <OgreRoot.h>
#include <OgreSceneManager.h>
#include <OgreSceneNode.h>
#include <OgreSkeleton.h>
#include <OgreSkeletonSerializer.h>
#include <OgreTextureBox.h>
#include <OgreWindow.h>
#include <Animation/OgreBone.h>
#include <Animation/OgreSkeletonDef.h>
#include <Animation/OgreSkeletonInstance.h>
#include <Animation/OgreSkeletonManager.h>
#include <Compositor/OgreCompositorManager2.h>
#include <Compositor/OgreCompositorWorkspace.h>
#include <Hlms/Pbs/OgreHlmsPbs.h>
#include <Hlms/Pbs/OgreHlmsPbsDatablock.h>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <iterator>
#include <string>
#include <vector>

namespace {

const char *const kMedia = "/usr/share/OGRE-Next/Media";
const char *const kGroup = "Tension";
const uint32_t kWindowWidth = 320;
const uint32_t kWindowHeight = 240;

std::vector<uint8_t> read_file(const std::string &path) {
    std::ifstream file(path, std::ios::binary);
    return std::vector<uint8_t>(std::istreambuf_iterator<char>(file),
                                std::istreambuf_iterator<char>());
}

std::string basename_of(const std::string &path) {
    const size_t slash = path.find_last_of('/');
    return slash == std::string::npos ? path : path.substr(slash + 1);
}

/// The manual skeleton: OGRE may call this on any reload, so the bytes live
/// beside the resource's owner (main's scope), and the call count proves the
/// conversion's lookup actually fired it.
struct SkeletonBytes final : public Ogre::ManualResourceLoader {
    std::vector<uint8_t> bytes;
    size_t load_calls = 0;
    void loadResource(Ogre::Resource *resource) override {
        ++load_calls;
        Ogre::v1::Skeleton *skeleton = static_cast<Ogre::v1::Skeleton *>(resource);
        Ogre::DataStreamPtr stream(
            new Ogre::MemoryDataStream(bytes.data(), bytes.size(), false, /* readOnly */ true));
        Ogre::v1::SkeletonSerializer serializer;
        serializer.importSkeleton(stream, skeleton);
    }
};

// ── the readback (the frame-listener path the earlier probes proved) ─────

struct Frame {
    uint32_t width = 0, height = 0, bpp = 0;
    std::vector<uint8_t> pixels;
};

struct Downloader : public Ogre::FrameListener {
    Ogre::Window *window = nullptr;
    bool wanted = false, ready = false;
    Frame frame;

    bool frameRenderingQueued(const Ogre::FrameEvent &) override {
        if (!wanted || ready || window == nullptr) return true;
        if (!window->canDownloadData()) return true;
        Ogre::Image2 image;
        Ogre::TextureGpu *backbuffer = window->getTexture();
        image.convertFromTexture(backbuffer, 0u, backbuffer->getNumMipmaps() - 1u);
        const Ogre::TextureBox box = image.getData(0);
        frame.width = box.width;
        frame.height = box.height;
        frame.bpp = box.bytesPerPixel;
        frame.pixels.assign(static_cast<size_t>(box.width) * box.height * box.bytesPerPixel, 0);
        for (uint32_t y = 0; y < box.height; ++y) {
            const uint8_t *row =
                static_cast<const uint8_t *>(box.data) + static_cast<size_t>(y) * box.bytesPerRow;
            std::memcpy(frame.pixels.data() + static_cast<size_t>(y) * box.width * box.bytesPerPixel,
                        row, static_cast<size_t>(box.width) * box.bytesPerPixel);
        }
        ready = true;
        wanted = false;
        window->setWantsToDownload(false);
        return true;
    }
};

bool grab(Ogre::Root *root, Downloader &downloader, Frame &out) {
    for (int attempt = 0; attempt < 3; ++attempt) {
        downloader.ready = false;
        downloader.wanted = true;
        downloader.window->setWantsToDownload(true);
        for (int i = 0; i < 16 && !downloader.ready; ++i) root->renderOneFrame();
        if (!downloader.ready) continue;
        const Frame &frame = downloader.frame;
        for (size_t i = 0; i + 2 < frame.pixels.size(); i += 4) {
            if (frame.pixels[i] || frame.pixels[i + 1] || frame.pixels[i + 2]) {
                out = frame;
                return true;
            }
        }
    }
    return false;
}

bool is_background(const Frame &frame, size_t x, size_t y) {
    const uint8_t *p = frame.pixels.data() + (y * frame.width + x) * frame.bpp;
    const int b0 = frame.pixels[0], b1 = frame.pixels[1], b2 = frame.pixels[2];
    return std::abs(static_cast<int>(p[0]) - b0) <= 8 &&
           std::abs(static_cast<int>(p[1]) - b1) <= 8 &&
           std::abs(static_cast<int>(p[2]) - b2) <= 8;
}

size_t non_background(const Frame &frame) {
    size_t count = 0;
    for (size_t y = 0; y < frame.height; ++y) {
        for (size_t x = 0; x < frame.width; ++x) {
            if (!is_background(frame, x, y)) ++count;
        }
    }
    return count;
}

double flip_fraction(const Frame &a, const Frame &b) {
    if (a.width != b.width || a.height != b.height || a.pixels.empty() || b.pixels.empty()) {
        return -1.0;
    }
    size_t flipped = 0, total = 0;
    for (size_t y = 0; y < a.height; ++y) {
        for (size_t x = 0; x < a.width; ++x) {
            ++total;
            if (is_background(a, x, y) != is_background(b, x, y)) ++flipped;
        }
    }
    return total == 0 ? -1.0 : static_cast<double>(flipped) / static_cast<double>(total);
}

void pose_bone(Ogre::SkeletonInstance *skeleton, size_t index, float angle_degrees,
               const Ogre::Vector3 &axis) {
    Ogre::Bone *bone = skeleton->getBone(index);
    const float radians = angle_degrees * 3.14159265358979f / 180.0f;
    bone->setOrientation(Ogre::Quaternion(Ogre::Radian(radians), axis));
    bone->setPosition(Ogre::Vector3::ZERO);
    bone->setScale(Ogre::Vector3::UNIT_SCALE);
}

/// The index of a bone by name, or SIZE_MAX.
size_t bone_index(Ogre::SkeletonInstance *skeleton, const char *name) {
    for (size_t i = 0; i < skeleton->getNumBones(); ++i) {
        if (skeleton->getBone(i)->getName() == name) return i;
    }
    return static_cast<size_t>(-1);
}

} // namespace

int main(int argc, char **argv) {
    std::setvbuf(stdout, nullptr, _IONBF, 0);
    if (argc < 4) {
        std::fprintf(stderr, "usage: probe_kenney <plugin-dir> <mesh> <skeleton>\n");
        return 2;
    }
    const std::string plugin_dir = argv[1];
    const std::string mesh_path = argv[2];
    const std::string skeleton_path = argv[3];

    const std::vector<uint8_t> mesh_bytes = read_file(mesh_path);
    std::vector<uint8_t> skeleton_bytes = read_file(skeleton_path);
    if (mesh_bytes.empty() || skeleton_bytes.empty()) {
        std::printf("KENNEY: could not read %s or %s\n", mesh_path.c_str(), skeleton_path.c_str());
        return 2;
    }
    std::printf("KENNEY: mesh %s (%zu bytes), skeleton %s (%zu bytes)\n", mesh_path.c_str(),
                mesh_bytes.size(), skeleton_path.c_str(), skeleton_bytes.size());

    {
        std::ofstream cfg("kenney_plugins.cfg");
        cfg << "PluginFolder=" << plugin_dir << "\n"
            << "Plugin=RenderSystem_GL3Plus\n";
    }
    Ogre::LogManager *logs = new Ogre::LogManager();
    logs->createLog("kenney_probe.log", true, false);

    Ogre::Root root(nullptr, "kenney_plugins.cfg", "kenney_probe.cfg", "kenney_probe.log", "kenney");
    Ogre::RenderSystem *rs = root.getRenderSystemByName("OpenGL 3+ Rendering Subsystem");
    if (rs == nullptr) {
        std::printf("KENNEY: the GL3+ render system is not in this install\n");
        return 2;
    }
    root.setRenderSystem(rs);
    root.initialise(false);

    Ogre::NameValuePairList params;
    params["width"] = std::to_string(kWindowWidth);
    params["height"] = std::to_string(kWindowHeight);
    Ogre::Window *window =
        root.createRenderWindow("kenney-probe", kWindowWidth, kWindowHeight, false, &params);
    Ogre::SceneManager *scene = root.createSceneManager(Ogre::ST_GENERIC, 1u, "kenney-mgr");
    scene->setForwardClustered(true, 16u, 8u, 24u, 96u, 2u, 0u, 0.0f, 100000.0f);

    Ogre::Camera *camera = scene->createCamera("kenney-camera");
    camera->setPosition(0.0f, 0.0f, 4.0f);
    camera->lookAt(0.0f, 0.0f, 0.0f);
    camera->setNearClipDistance(0.1f);
    camera->setAutoAspectRatio(true);

    Ogre::CompositorManager2 *compositors = root.getCompositorManager2();
    compositors->createBasicWorkspaceDef("kenney-workspace", Ogre::ColourValue(0.1f, 0.1f, 0.1f, 1.0f));
    if (compositors->addWorkspace(scene, window->getTexture(), camera, "kenney-workspace", true) ==
        nullptr) {
        std::printf("KENNEY: the workspace was refused\n");
        return 2;
    }
    Downloader downloader;
    downloader.window = window;
    root.addFrameListener(&downloader);

    // The group: created empty and initialised, exactly as the adapter must
    // have it, with **no resource location** anywhere — the bytes come from
    // the files above and nowhere else.
    {
        Ogre::ResourceGroupManager &rgm = Ogre::ResourceGroupManager::getSingleton();
        if (!rgm.resourceGroupExists(kGroup)) rgm.createResourceGroup(kGroup);
        rgm.initialiseResourceGroup(Ogre::String(kGroup), false);
        std::printf("KENNEY: group \"%s\" exists, empty — no resource location anywhere\n", kGroup);
    }

    // The rig, registered by hand before the import (the 11b order).
    SkeletonBytes loader;
    loader.bytes = skeleton_bytes;
    const std::string skeleton_name = basename_of(skeleton_path);
    Ogre::v1::SkeletonPtr skeleton = Ogre::v1::OldSkeletonManager::getSingleton().create(
        skeleton_name, kGroup, /* isManual */ true, &loader);
    std::printf("KENNEY: registered manual skeleton \"%s\"\n", skeleton_name.c_str());

    // The mesh, the way realise_mesh does it.
    Ogre::v1::MeshPtr v1;
    Ogre::MeshPtr mesh;
    try {
        Ogre::DataStreamPtr stream(new Ogre::MemoryDataStream(
            const_cast<uint8_t *>(mesh_bytes.data()), mesh_bytes.size(), false, true));
        v1 = Ogre::v1::MeshManager::getSingleton().createManual("kenney-v1", kGroup);
        Ogre::v1::MeshSerializer serializer;
        serializer.importMesh(stream, v1.get());
        mesh = Ogre::MeshManager::getSingleton().createByImportingV1("kenney", kGroup, v1.get(),
                                                                     false, false, false);
        mesh->load();
    } catch (const std::exception &e) {
        std::printf("KENNEY: the import threw: %s\n", e.what());
        return 3;
    }

    const bool rigged = mesh->hasSkeleton();
    const Ogre::String linked = mesh->getSkeletonName();
    std::printf("KENNEY: hasSkeleton=%s skeletonName=\"%s\" matches-registered=%s\n",
                rigged ? "true" : "false", linked.c_str(),
                linked == skeleton_name ? "yes" : "NO (the 11a trap)");
    if (!rigged || mesh->getSkeleton() == nullptr) {
        std::printf("KENNEY: the mesh came back rigged with no def — conversion problem, stop here\n");
        return 3;
    }
    const size_t bone_count = mesh->getSkeleton()->getBones().size();
    std::printf("KENNEY: %zu bones in the def; loader fired %zu time(s)\n", bone_count,
                loader.load_calls);
    for (size_t i = 0; i < bone_count; ++i) {
        const Ogre::SkeletonDef::BoneData &bone = mesh->getSkeleton()->getBones()[i];
        std::printf("  %2zu  %s\n", i, bone.name.c_str());
    }

    // Draw it: a PBS material whose colour is emissive (this probe is about
    // skinning, not lighting), framed by the mesh's own bounds.
    Ogre::ArchiveManager &archives = Ogre::ArchiveManager::getSingleton();
    Ogre::String pbs_main;
    Ogre::StringVector pbs_lib_paths;
    Ogre::HlmsPbs::getDefaultPaths(pbs_main, pbs_lib_paths);
    Ogre::ArchiveVec pbs_library;
    for (const Ogre::String &path : pbs_lib_paths) {
        pbs_library.push_back(archives.load(std::string(kMedia) + "/" + path, "FileSystem", true));
    }
    Ogre::HlmsPbs *pbs =
        new Ogre::HlmsPbs(archives.load(std::string(kMedia) + "/" + pbs_main, "FileSystem", true),
                          &pbs_library);
    root.getHlmsManager()->registerHlms(pbs);

    Ogre::HlmsMacroblock macroblock;
    Ogre::HlmsBlendblock blendblock;
    Ogre::HlmsParamVec param_vec;
    auto *datablock = static_cast<Ogre::HlmsPbsDatablock *>(
        pbs->createDatablock("kenney-skin", "kenney-skin", macroblock, blendblock, param_vec));
    datablock->setDiffuse(Ogre::Vector3(0.0f, 0.0f, 0.0f));
    datablock->setSpecular(Ogre::Vector3(0.0f, 0.0f, 0.0f));
    datablock->setEmissive(Ogre::Vector3(0.9f, 0.2f, 0.2f));
    datablock->setRoughness(1.0f);
    datablock->setMetalness(0.0f);

    Ogre::Item *item = scene->createItem(mesh, Ogre::SCENE_DYNAMIC);
    item->setDatablock(datablock);
    Ogre::SceneNode *node =
        scene->getRootSceneNode(Ogre::SCENE_DYNAMIC)->createChildSceneNode(Ogre::SCENE_DYNAMIC);
    node->attachObject(item);

    // The bounding box at scale 1 (the number 12b turns into a frame-fitting
    // scale), then the framing this probe uses.
    const Ogre::Aabb bounds = item->getWorldAabb();
    const float height = bounds.getMaximum().y - bounds.getMinimum().y;
    const float fitted = height > 0.001f ? 2.5f / height : 1.0f;
    std::printf("KENNEY: bounds %.3f,%.3f,%.3f .. %.3f,%.3f,%.3f (height %.3f) -> scale %.4f\n",
                static_cast<double>(bounds.getMinimum().x),
                static_cast<double>(bounds.getMinimum().y),
                static_cast<double>(bounds.getMinimum().z),
                static_cast<double>(bounds.getMaximum().x),
                static_cast<double>(bounds.getMaximum().y),
                static_cast<double>(bounds.getMaximum().z), static_cast<double>(height),
                static_cast<double>(fitted));
    node->setScale(fitted, fitted, fitted);
    for (int settle = 0; settle < 3; ++settle) root.renderOneFrame();

    Ogre::SkeletonInstance *skeleton_instance = item->getSkeletonInstance();
    if (skeleton_instance == nullptr) {
        std::printf("KENNEY: the item came back with no skeleton instance\n");
        return 3;
    }
    std::printf("KENNEY: item skeleton instance has %zu bones\n", skeleton_instance->getNumBones());

    // The rest pose, read off the rig: the hands' derived positions relative to
    // the hips. Arms out to the sides = a T-pose; hands near the hips = the
    // pack's idle pose.
    {
        const size_t hips = bone_index(skeleton_instance, "Hips");
        const size_t left_hand = bone_index(skeleton_instance, "LeftHand");
        const size_t right_hand = bone_index(skeleton_instance, "RightHand");
        if (hips != static_cast<size_t>(-1) && left_hand != static_cast<size_t>(-1) &&
            right_hand != static_cast<size_t>(-1)) {
            const Ogre::Vector3 h = skeleton_instance->getBone(hips)->_getDerivedTransform().getTrans();
            const Ogre::Vector3 l =
                skeleton_instance->getBone(left_hand)->_getDerivedTransform().getTrans();
            const Ogre::Vector3 r =
                skeleton_instance->getBone(right_hand)->_getDerivedTransform().getTrans();
            std::printf("KENNEY: rest pose: hips (%.3f,%.3f,%.3f), left hand (%.3f,%.3f,%.3f), "
                        "right hand (%.3f,%.3f,%.3f) — hands %.3f / %.3f from the hips "
                        "horizontally, %.3f vertically\n",
                        static_cast<double>(h.x), static_cast<double>(h.y), static_cast<double>(h.z),
                        static_cast<double>(l.x), static_cast<double>(l.y), static_cast<double>(l.z),
                        static_cast<double>(r.x), static_cast<double>(r.y), static_cast<double>(r.z),
                        static_cast<double>(std::abs(l.x - h.x)),
                        static_cast<double>(std::abs(r.x - h.x)),
                        static_cast<double>(std::abs(l.y - h.y)));
        } else {
            std::printf("KENNEY: rest pose: no Hips/LeftHand/RightHand by those names\n");
        }
    }

    // ── animation (chunk 13a A.3) ────────────────────────────────────────
    // Does OGRE-Next 3.0 play what the conversion wrote? The v2 API is
    // SkeletonInstance::getAnimation(name) -> a SkeletonAnimation with
    // addTime/setTime/setLoop/setEnabled (Animation/OgreSkeletonAnimation.h).
    // The clip's duration is the loop point; 60 frames at 1/60 s is longer
    // than the 0.667 s clip, so both are measured: the pose at frame 60 and
    // the pose at exactly one duration.
    Ogre::SkeletonAnimation *playing = nullptr;
    {
        const auto &animations = skeleton_instance->getAnimations();
        std::printf("KENNEY animation: %zu animation(s) on the instance\n", animations.size());
        for (const Ogre::SkeletonAnimation &animation : animations) {
            std::printf("  \"%s\": %.1f frames, duration %.3f s\n",
                        animation.getName().getFriendlyText().c_str(),
                        static_cast<double>(animation.getNumFrames()),
                        static_cast<double>(animation.getDuration()));
        }
        if (!animations.empty()) {
            playing = skeleton_instance->getAnimation(animations[0].getName());
        }
    }
    if (playing != nullptr) {
        playing->setEnabled(true);
        playing->setLoop(true);
        const Ogre::Real dt = 1.0f / 60.0f;
        const size_t hips = bone_index(skeleton_instance, "Hips");

        Frame at0, at30, at60, at_duration;
        if (!grab(&root, downloader, at0)) {
            std::printf("KENNEY animation: no frame at t=0\n");
            return 3;
        }
        const Ogre::Quaternion q0 =
            skeleton_instance->getBone(hips)->_getDerivedTransform().extractQuaternion();
        for (int i = 0; i < 30; ++i) {
            playing->addTime(dt);
            root.renderOneFrame();
        }
        if (!grab(&root, downloader, at30)) {
            std::printf("KENNEY animation: no frame at t=30\n");
            return 3;
        }
        const Ogre::Quaternion q30 =
            skeleton_instance->getBone(hips)->_getDerivedTransform().extractQuaternion();
        for (int i = 0; i < 30; ++i) {
            playing->addTime(dt);
            root.renderOneFrame();
        }
        if (!grab(&root, downloader, at60)) {
            std::printf("KENNEY animation: no frame at t=60\n");
            return 3;
        }
        // The true loop point: exactly one duration after the start.
        playing->setTime(playing->getDuration());
        root.renderOneFrame();
        if (!grab(&root, downloader, at_duration)) {
            std::printf("KENNEY animation: no frame at one duration\n");
            return 3;
        }

        const float dot = std::min(1.0f, std::abs(q0.Dot(q30)));
        const double angle0_30 = 2.0 * std::acos(static_cast<double>(dot)) * 57.29578;
        std::printf("KENNEY animation: hips orientation moved %.4f deg over 30 frames "
                    "(%zu px at 0, %zu at 30, %zu at 60)\n",
                    angle0_30, non_background(at0), non_background(at30), non_background(at60));
        std::printf("KENNEY animation: flip 0->30 %.5f, 30->60 %.5f, loop closure (one duration "
                    "vs t=0) %.5f\n",
                    flip_fraction(at0, at30), flip_fraction(at30, at60),
                    flip_fraction(at0, at_duration));
        playing->setEnabled(false);
        playing->setTime(0.0f);
        for (int i = 0; i < 2; ++i) root.renderOneFrame();
    } else {
        std::printf("KENNEY animation: none to play\n");
    }

    // ── facing (chunk 12b) ───────────────────────────────────────────────
    // Which way does the character point in its own space? The toes do: a
    // humanoid's feet extend forward, so `toe_z - foot_z` is the facing sign.
    // The camera in this probe (and in walking-stickman) sits on +Z looking at
    // the origin, so a character whose toes point +Z faces the camera.
    {
        const size_t left_foot = bone_index(skeleton_instance, "LeftFoot");
        const size_t left_toes = bone_index(skeleton_instance, "LeftToes");
        const size_t right_foot = bone_index(skeleton_instance, "RightFoot");
        const size_t right_toes = bone_index(skeleton_instance, "RightToes");
        const size_t head = bone_index(skeleton_instance, "Head");
        if (left_toes != static_cast<size_t>(-1) && left_foot != static_cast<size_t>(-1)) {
            const Ogre::Vector3 lf =
                skeleton_instance->getBone(left_foot)->_getDerivedTransform().getTrans();
            const Ogre::Vector3 lt =
                skeleton_instance->getBone(left_toes)->_getDerivedTransform().getTrans();
            const Ogre::Vector3 rf =
                skeleton_instance->getBone(right_foot)->_getDerivedTransform().getTrans();
            const Ogre::Vector3 rt =
                skeleton_instance->getBone(right_toes)->_getDerivedTransform().getTrans();
            const double head_z = head != static_cast<size_t>(-1)
                                      ? static_cast<double>(skeleton_instance->getBone(head)
                                                                ->_getDerivedTransform()
                                                                .getTrans()
                                                                .z)
                                      : 0.0;
            std::printf("KENNEY facing: foot->toe z  left %.3f, right %.3f (head z %.3f) -> "
                        "faces %sZ %s\n",
                        static_cast<double>(lt.z - lf.z), static_cast<double>(rt.z - rf.z), head_z,
                        (lt.z - lf.z) + (rt.z - rf.z) > 0.0 ? "+" : "-",
                        (lt.z - lf.z) + (rt.z - rf.z) > 0.0
                            ? "(toward a +Z camera: front view)"
                            : "(away from a +Z camera: back view)");
        } else {
            std::printf("KENNEY facing: no toe bones on this rig; bone names:\n");
            for (size_t i = 0; i < skeleton_instance->getNumBones(); ++i) {
                std::printf("  %2zu %s\n", i, skeleton_instance->getBone(i)->getName().c_str());
            }
        }
    }

    Frame rest;
    if (!grab(&root, downloader, rest)) {
        std::printf("KENNEY: the rest frame could not be captured\n");
        return 3;
    }
    std::printf("KENNEY: rest frame: %zu non-background px\n", non_background(rest));

    const size_t forearm = bone_index(skeleton_instance, "LeftForeArm");
    const size_t hips = bone_index(skeleton_instance, "Hips");
    std::printf("KENNEY: LeftForeArm is bone %zd, Hips is bone %zd (by name, on the instance)\n",
                static_cast<ssize_t>(forearm), static_cast<ssize_t>(hips));
    if (forearm == static_cast<size_t>(-1) || hips == static_cast<size_t>(-1)) {
        std::printf("KENNEY: the rig does not carry the expected bone names — stop and report\n");
        return 3;
    }

    double forearm_flip = -1.0, hips_flip = -1.0;
    {
        pose_bone(skeleton_instance, forearm, 45.0f, Ogre::Vector3::UNIT_X);
        for (int settle = 0; settle < 3; ++settle) root.renderOneFrame();
        Frame posed;
        if (grab(&root, downloader, posed)) {
            forearm_flip = flip_fraction(rest, posed);
            std::printf("KENNEY: LeftForeArm 45deg about X: flip %.5f, %zu non-background px\n",
                        forearm_flip, non_background(posed));
        }
        pose_bone(skeleton_instance, forearm, 0.0f, Ogre::Vector3::UNIT_X);
        for (int settle = 0; settle < 2; ++settle) root.renderOneFrame();
    }
    {
        pose_bone(skeleton_instance, hips, 15.0f, Ogre::Vector3::UNIT_Z);
        for (int settle = 0; settle < 3; ++settle) root.renderOneFrame();
        Frame posed;
        if (grab(&root, downloader, posed)) {
            hips_flip = flip_fraction(rest, posed);
            std::printf("KENNEY: Hips 15deg about Z: flip %.5f, %zu non-background px\n", hips_flip,
                        non_background(posed));
        }
    }

    std::printf("KENNEY verdict: %s (forearm flip %.5f, hips flip %.5f)\n",
                forearm_flip > 0.0 && hips_flip > 0.0 ? "SKINS" : "DOES NOT SKIN", forearm_flip,
                hips_flip);
    return forearm_flip > 0.0 && hips_flip > 0.0 ? 0 : 3;
}
