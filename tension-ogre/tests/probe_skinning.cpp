// probe_skinning.cpp — six measurements before anything is written against them
// (chunk 5, round 5b).
//
//   1. which shipped meshes are rigged *after* the v1->v2 conversion
//   2. whether the conversion needs the skeleton reachable by name
//   3. whether createItem on a rigged Mesh2 yields an Item with a skeleton
//   4. the minimal bone-posing sequence that actually moves the mesh
//   5. what it costs per bone per frame
//   6. which bone, and how large a silhouette change, for the acid test
//
// Committed as a probe, like probe_loader/probe_ogre/probe_scene/probe_motion:
// the numbers in the round's report come from this binary.
//
//   g++ -std=c++17 -O1 -isystem /usr/include/OGRE-Next \
//       -isystem /usr/include/OGRE-Next/Hlms/Common \
//       -isystem /usr/include/OGRE-Next/Hlms/Unlit \
//       -isystem /usr/include/OGRE-Next/Hlms/Pbs \
//       tests/probe_skinning.cpp -o build/probe-skinning/probe_skinning \
//       -lOgreNextMain -lOgreNextHlmsUnlit -lOgreNextHlmsPbs -lpthread
//   ./probe_skinning /usr/lib/OGRE-Next [--no-location]

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
#include <OgreRenderSystem.h>
#include <OgreResourceGroupManager.h>
#include <OgreRoot.h>
#include <OgreSceneManager.h>
#include <OgreSceneNode.h>
#include <OgreTextureBox.h>
#include <OgreTextureGpu.h>
#include <OgreWindow.h>

#include <Animation/OgreBone.h>
#include <Animation/OgreSkeletonDef.h>
#include <Animation/OgreSkeletonInstance.h>
#include <Compositor/OgreCompositorManager2.h>
#include <Compositor/OgreCompositorWorkspace.h>
#include <Hlms/Pbs/OgreHlmsPbs.h>
#include <Hlms/Unlit/OgreHlmsUnlit.h>
#include <Hlms/Unlit/OgreHlmsUnlitDatablock.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <iterator>
#include <string>
#include <vector>

namespace {

const char *const kMedia = "/usr/share/OGRE-Next/Media";
const char *const kGroup = "General";
const uint32_t kWindowWidth = 320;
const uint32_t kWindowHeight = 240;
const float kScale = 0.02f;

std::vector<uint8_t> read_file(const std::string &path) {
    std::ifstream file(path, std::ios::binary);
    return std::vector<uint8_t>(std::istreambuf_iterator<char>(file),
                                std::istreambuf_iterator<char>());
}

double now_us() {
    using clock = std::chrono::steady_clock;
    return std::chrono::duration<double, std::micro>(clock::now().time_since_epoch()).count();
}

// ── the readback (the frame-listener path probe_motion proved) ───────────

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
            std::memcpy(frame.pixels.data() +
                            static_cast<size_t>(y) * box.width * box.bytesPerPixel,
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
    return p[0] < 40 && p[1] < 40 && p[2] < 40;
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

/// The fraction of pixels whose background-ness differs between two frames —
/// the cheapest honest measure of "the silhouette changed shape".
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

/// Mean absolute per-channel difference over the whole frame.
double mean_delta(const Frame &a, const Frame &b) {
    if (a.pixels.size() != b.pixels.size() || a.pixels.empty()) return -1.0;
    double sum = 0;
    size_t samples = 0;
    for (size_t i = 0; i + 2 < a.pixels.size(); i += 4) {
        sum += std::abs(static_cast<int>(a.pixels[i]) - static_cast<int>(b.pixels[i]));
        sum += std::abs(static_cast<int>(a.pixels[i + 1]) - static_cast<int>(b.pixels[i + 1]));
        sum += std::abs(static_cast<int>(a.pixels[i + 2]) - static_cast<int>(b.pixels[i + 2]));
        samples += 3;
    }
    return samples == 0 ? -1.0 : sum / static_cast<double>(samples);
}

/// The 3a mesh recipe, with the skeleton question attached.
struct Loaded {
    Ogre::MeshPtr mesh;
    bool rigged = false;
    size_t bones = 0;
    Ogre::String skeleton_name;
    Ogre::String note;
};

Loaded load_mesh(const Ogre::String &file) {
    Loaded loaded;
    try {
        const std::vector<uint8_t> bytes = read_file(std::string(kMedia) + "/models/" + file.c_str());
        if (bytes.empty()) {
            loaded.note = "could not be read";
            return loaded;
        }
        Ogre::DataStreamPtr stream(new Ogre::MemoryDataStream(
            const_cast<uint8_t *>(bytes.data()), bytes.size(), false, true));
        Ogre::v1::MeshPtr v1 = Ogre::v1::MeshManager::getSingleton().createManual(
            file + "-v1", kGroup);
        Ogre::v1::MeshSerializer serializer;
        serializer.importMesh(stream, v1.get());
        loaded.mesh = Ogre::MeshManager::getSingleton().createByImportingV1(
            file, kGroup, v1.get(), false, false, false);
        loaded.mesh->load();
        loaded.rigged = loaded.mesh->hasSkeleton();
        if (loaded.rigged) {
            loaded.skeleton_name = loaded.mesh->getSkeletonName();
            if (loaded.mesh->getSkeleton()) {
                loaded.bones = loaded.mesh->getSkeleton()->getBones().size();
            }
        }
    } catch (const std::exception &e) {
        loaded.note = e.what();
    }
    return loaded;
}

void pose_bone(Ogre::SkeletonInstance *skeleton, size_t index, float angle_degrees) {
    Ogre::Bone *bone = skeleton->getBone(index);
    const float radians = angle_degrees * 3.14159265358979f / 180.0f;
    const Ogre::Quaternion turn(Ogre::Radian(radians), Ogre::Vector3::UNIT_X);
    bone->setOrientation(turn);
    bone->setPosition(Ogre::Vector3::ZERO);
    bone->setScale(Ogre::Vector3::UNIT_SCALE);
}

} // namespace

int main(int argc, char **argv) {
    std::setvbuf(stdout, nullptr, _IONBF, 0);
    if (argc < 2) {
        std::fprintf(stderr, "usage: probe_skinning <plugin-dir> [--no-location]\n");
        return 2;
    }
    const std::string plugin_dir = argv[1];
    bool add_location = true;
    for (int i = 2; i < argc; ++i) {
        if (std::string(argv[i]) == "--no-location") add_location = false;
    }

    {
        std::ofstream cfg("skinning_plugins.cfg");
        cfg << "PluginFolder=" << plugin_dir << "\n"
            << "Plugin=RenderSystem_GL3Plus\n";
    }
    Ogre::LogManager *logs = new Ogre::LogManager();
    logs->createLog("skinning_probe.log", true, false);

    Ogre::Root root(nullptr, "skinning_plugins.cfg", "skinning_probe.cfg", "skinning_probe.log",
                    "skinning");
    Ogre::RenderSystem *rs = root.getRenderSystemByName("OpenGL 3+ Rendering Subsystem");
    if (rs == nullptr) {
        std::printf("SKIN: the GL3+ render system is not in this install\n");
        return 2;
    }
    root.setRenderSystem(rs);
    root.initialise(false);

    Ogre::NameValuePairList params;
    params["width"] = std::to_string(kWindowWidth);
    params["height"] = std::to_string(kWindowHeight);
    Ogre::Window *window =
        root.createRenderWindow("skinning-probe", kWindowWidth, kWindowHeight, false, &params);
    Ogre::SceneManager *scene = root.createSceneManager(Ogre::ST_GENERIC, 1u, "skinning-mgr");

    Ogre::Camera *camera = scene->createCamera("skinning-camera");
    camera->setPosition(0.0f, 0.0f, 4.0f);
    camera->lookAt(0.0f, 0.0f, 0.0f);
    camera->setNearClipDistance(0.1f);
    camera->setAutoAspectRatio(true);

    Ogre::CompositorManager2 *compositors = root.getCompositorManager2();
    compositors->createBasicWorkspaceDef("skinning-workspace", Ogre::ColourValue(0.1f, 0.1f, 0.1f, 1.0f));
    if (compositors->addWorkspace(scene, window->getTexture(), camera, "skinning-workspace", true) ==
        nullptr) {
        std::printf("SKIN: the workspace was refused\n");
        return 2;
    }

    Downloader downloader;
    downloader.window = window;
    root.addFrameListener(&downloader);

    // ── Q2 first: is the skeleton reachable by name? ─────────────────────
    // The resource location is what makes `createByImportingV1` able to find
    // "Stickman.skeleton" beside the mesh; without it, the conversion has only
    // the bytes we handed it.
    if (add_location) {
        Ogre::ResourceGroupManager::getSingleton().addResourceLocation(
            std::string(kMedia) + "/models", "FileSystem", kGroup, false);
        std::printf("SKIN Q2: added resource location %s/models to group %s\n", kMedia, kGroup);
    } else {
        std::printf("SKIN Q2: no resource location configured (the mesh bytes are all OGRE gets)\n");
    }

    // ── Q1: which shipped meshes survive the conversion rigged ───────────
    std::printf("SKIN Q1: which shipped meshes are rigged after v1->v2\n");
    const char *const candidates[] = {"Stickman.mesh", "Smiley.mesh", "fish.mesh", "jaiqua.mesh"};
    std::vector<Loaded> loaded_meshes;
    for (const char *file : candidates) {
        loaded_meshes.push_back(load_mesh(file));
        const Loaded &loaded = loaded_meshes.back();
        if (!loaded.mesh) {
            std::printf("  %-14s FAILED: %s\n", file, loaded.note.c_str());
            continue;
        }
        std::printf("  %-14s hasSkeleton=%s bones=%zu skeleton=\"%s\" submeshes=%u\n", file,
                    loaded.rigged ? "true" : "false", loaded.bones,
                    loaded.skeleton_name.c_str(), loaded.mesh->getNumSubMeshes());
    }

    // ── Q3: an Item from a rigged mesh ───────────────────────────────────
    // The mesh comes from Q1's load, not a second one: OGRE's mesh manager keys
    // by name, and asking for "Stickman.mesh" twice hands back the first one
    // (measured — a second load reported the rig gone, which was the probe's
    // bug and not the conversion's).
    const Loaded &rigged = loaded_meshes[0];
    if (!rigged.rigged) {
        std::printf("SKIN: Stickman.mesh came back unrigged — the conversion dropped the rig\n");
        return 3;
    }
    Ogre::ArchiveManager &archives = Ogre::ArchiveManager::getSingleton();
    Ogre::Archive *unlit_sources =
        archives.load(std::string(kMedia) + "/Hlms/Unlit/GLSL", "FileSystem", true);
    Ogre::Archive *pbs_sources =
        archives.load(std::string(kMedia) + "/Hlms/Pbs/GLSL", "FileSystem", true);
    Ogre::ArchiveVec library;
    library.push_back(archives.load(std::string(kMedia) + "/Hlms/Common/GLSL", "FileSystem", true));
    library.push_back(archives.load(std::string(kMedia) + "/Hlms/Common/Any", "FileSystem", true));
    library.push_back(archives.load(std::string(kMedia) + "/Hlms/Unlit/Any", "FileSystem", true));
    library.push_back(archives.load(std::string(kMedia) + "/Hlms/Pbs/Any", "FileSystem", true));
    Ogre::HlmsUnlit *unlit = new Ogre::HlmsUnlit(unlit_sources, &library);
    Ogre::HlmsPbs *pbs = new Ogre::HlmsPbs(pbs_sources, &library);
    root.getHlmsManager()->registerHlms(unlit);
    root.getHlmsManager()->registerHlms(pbs);
    Ogre::HlmsMacroblock macroblock;
    Ogre::HlmsBlendblock blendblock;
    Ogre::HlmsParamVec param_vec;
    Ogre::HlmsUnlitDatablock *datablock = static_cast<Ogre::HlmsUnlitDatablock *>(
        unlit->createDatablock("skin-red", "skin-red", macroblock, blendblock, param_vec));
    datablock->setUseColour(true);
    datablock->setColour(Ogre::ColourValue(0.9f, 0.6f, 0.2f, 1.0f));

    Ogre::Item *item = scene->createItem(rigged.mesh, Ogre::SCENE_DYNAMIC);
    item->setDatablock(datablock);
    Ogre::SceneNode *node = scene->getRootSceneNode(Ogre::SCENE_DYNAMIC)
                                ->createChildSceneNode(Ogre::SCENE_DYNAMIC);
    node->attachObject(item);

    // The barrel was ~5 units across and 0.02 fitted the frame; a rigged
    // character is not the barrel, so the scale is measured rather than assumed.
    const Ogre::Aabb bounds = item->getWorldAabb();
    const Ogre::Vector3 lo = bounds.getMinimum(), hi = bounds.getMaximum();
    std::printf("SKIN: mesh bounds %.2f,%.2f,%.2f .. %.2f,%.2f,%.2f (height %.2f)\n",
                static_cast<double>(lo.x), static_cast<double>(lo.y), static_cast<double>(lo.z),
                static_cast<double>(hi.x), static_cast<double>(hi.y), static_cast<double>(hi.z),
                static_cast<double>(hi.y - lo.y));
    float scale = kScale;
    const float scales[] = {0.02f, 0.2f, 1.0f};
    for (float candidate : scales) {
        node->setScale(candidate, candidate, candidate);
        for (int settle = 0; settle < 3; ++settle) root.renderOneFrame();
        Frame try_frame;
        if (!grab(&root, downloader, try_frame)) continue;
        const size_t pixels = non_background(try_frame);
        std::printf("SKIN: at scale %.2f the mesh covers %zu non-background pixels%s\n",
                    static_cast<double>(candidate), pixels,
                    pixels > 40 && pixels < 40000 ? "  <- using this" : "");
        if (pixels > 40 && pixels < 40000) {
            scale = candidate;
            break;
        }
    }
    node->setScale(scale, scale, scale);

    // The skinning path is prepared by the *conversion*, and the blend map is
    // where it shows: `RenderableAnimated::getBlendIndexToBoneIndexMap()` is
    // non-null exactly when the subitem's vertices carry blend indices.
    std::printf("SKIN Q3b: subitems=%u\n", item->getNumSubItems());
    for (size_t s = 0; s < item->getNumSubItems(); ++s) {
        const Ogre::RenderableAnimated::IndexMap *map =
            item->getSubItem(s)->getBlendIndexToBoneIndexMap();
        std::printf("  subitem %zu: blend map %s (%zu entries)\n", s,
                    map != nullptr ? "non-null" : "NULL", map != nullptr ? map->size() : 0);
    }
    Ogre::SkeletonInstance *skeleton = item->getSkeletonInstance();
    std::printf("SKIN Q3: createItem(rigged mesh) -> hasSkeleton=%s instance=%s bones=%zu\n",
                item->hasSkeleton() ? "true" : "false", skeleton != nullptr ? "non-null" : "NULL",
                skeleton != nullptr ? skeleton->getNumBones() : 0);
    if (skeleton == nullptr) {
        std::printf("SKIN: the Item has no SkeletonInstance — nothing to pose\n");
        return 3;
    }
    std::printf("SKIN Q3: %zu bones:", skeleton->getNumBones());
    for (size_t i = 0; i < skeleton->getNumBones() && i < 12; ++i) {
        std::printf(" [%zu]%s", i, skeleton->getBone(i)->getName().c_str());
    }
    std::printf("%s\n", skeleton->getNumBones() > 12 ? " ..." : "");

    // ── Q6 first: which bone changes the silhouette most (rest pose = baseline)
    for (int settle = 0; settle < 3; ++settle) root.renderOneFrame();
    Frame rest;
    if (!grab(&root, downloader, rest)) {
        std::printf("SKIN: could not download the rest pose\n");
        return 4;
    }
    const size_t rest_pixels = non_background(rest);
    std::printf("SKIN Q6: rest pose: %zu non-background pixels\n", rest_pixels);

    size_t best_bone = 0;
    double best_flip = -1.0;
    const size_t try_bones = std::min<size_t>(skeleton->getNumBones(), 10);
    std::vector<double> flips(try_bones, 0.0);
    for (size_t i = 0; i < try_bones; ++i) {
        pose_bone(skeleton, i, 90.0f);
        skeleton->update();
        for (int settle = 0; settle < 3; ++settle) root.renderOneFrame();
        Frame posed;
        if (!grab(&root, downloader, posed)) {
            std::printf("SKIN Q6: bone %zu could not be captured\n", i);
            continue;
        }
        flips[i] = flip_fraction(rest, posed);
        std::printf("  bone %2zu %-12s flip %.5f  non-bg %zu\n", i,
                    skeleton->getBone(i)->getName().c_str(), flips[i], non_background(posed));
        if (flips[i] > best_flip) {
            best_flip = flips[i];
            best_bone = i;
        }
        pose_bone(skeleton, i, 0.0f); // back to rest for the next candidate
        skeleton->update();
    }
    std::printf("SKIN Q6: clearest bone: %zu \"%s\" with flip %.5f\n", best_bone,
                skeleton->getBone(best_bone)->getName().c_str(), best_flip);

    // ── Q4: the posing sequence ──────────────────────────────────────────
    // Four combinations, each measured the only way that matters: did the
    // *mesh* change? A skeleton's derived transform can move without the
    // renderer following it, so both signals are reported.
    std::printf("SKIN Q4: the minimal sequence that moves the mesh\n");
    std::printf("SKIN Q4: animations available=%zu active=%zu\n", skeleton->getAnimations().size(),
                skeleton->getActiveAnimations().size());
    const char *const labels[] = {"set only", "set + update()", "set then manual",
                                  "set then manual + update()", "manual then set",
                                  "manual then set + update()", "manual then set, no update"};
    for (int combination = 0; combination < 7; ++combination) {
        skeleton->resetToPose();
        skeleton->update();
        const Ogre::SimpleMatrixAf4x3 before = skeleton->_getBoneFullTransform(best_bone);
        if (combination >= 4) skeleton->setManualBone(skeleton->getBone(best_bone), true);
        pose_bone(skeleton, best_bone, 90.0f);
        if (combination == 1 || combination == 3 || combination == 5) skeleton->update();
        if (combination == 2 || combination == 3) {
            skeleton->setManualBone(skeleton->getBone(best_bone), true);
        }
        for (int settle = 0; settle < 3; ++settle) root.renderOneFrame();
        Frame posed;
        const bool got = grab(&root, downloader, posed);
        const Ogre::SimpleMatrixAf4x3 after = skeleton->_getBoneFullTransform(best_bone);
        // The full transform is a SIMD type with no element access; comparing
        // its bytes is the honest test of "did the bone's world transform move".
        const bool bone_moved =
            std::memcmp(&before, &after, sizeof(before)) != 0;
        const Ogre::Bone *bone = skeleton->getBone(best_bone);
        const Ogre::Quaternion local = bone->getOrientation();
        std::printf("  %-32s derived moved=%s  local w=%.3f (set 0.707)  flip=%.5f\n",
                    labels[combination], bone_moved ? "yes" : "no ", static_cast<double>(local.w),
                    got ? flip_fraction(rest, posed) : -1.0);
    }
    skeleton->resetToPose();
    skeleton->update();

    // ── Q5: the cost of driving bones ────────────────────────────────────
    std::printf("SKIN Q5: the cost of driving M bones per frame (300 frames)\n");
    const size_t counts[] = {1, 16, 64};
    for (size_t m : counts) {
        const size_t driving = std::min(m, skeleton->getNumBones());
        double pose_total = 0, render_total = 0;
        const double wall_start = now_us();
        for (int frame = 0; frame < 300; ++frame) {
            const double t0 = now_us();
            const float angle = 30.0f * std::sin(static_cast<float>(frame) * 0.05f);
            for (size_t i = 0; i < driving; ++i) pose_bone(skeleton, i, angle);
            skeleton->update();
            const double t1 = now_us();
            root.renderOneFrame();
            const double t2 = now_us();
            pose_total += t1 - t0;
            render_total += t2 - t1;
        }
        const double wall = now_us() - wall_start;
        std::printf("  M=%-3zu (driving %-3zu) pose %7.1f us/frame  render %7.1f us/frame  "
                    "%6.1f fps\n",
                    m, driving, pose_total / 300.0, render_total / 300.0,
                    300.0 / (wall / 1e6));
    }
    skeleton->resetToPose();
    skeleton->update();

    // ── Q6's numbers, at the size the acid test will use ──────────────────
    for (int settle = 0; settle < 3; ++settle) root.renderOneFrame();
    Frame final_rest;
    grab(&root, downloader, final_rest);
    pose_bone(skeleton, best_bone, 90.0f);
    skeleton->update();
    for (int settle = 0; settle < 3; ++settle) root.renderOneFrame();
    Frame final_posed;
    grab(&root, downloader, final_posed);
    std::printf("SKIN Q6: rest %zu px, posed %zu px, flip %.5f, mean delta %.3f\n",
                non_background(final_rest), non_background(final_posed),
                flip_fraction(final_rest, final_posed), mean_delta(final_rest, final_posed));

    for (int settle = 0; settle < 3; ++settle) root.renderOneFrame();
    root.shutdown();
    std::printf("SKIN: probe complete\n");
    return 0;
}
