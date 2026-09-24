// probe_skeleton_tns.cpp — does a rigged mesh's skeleton have to be a file on
// disk? (chunk 11, round 11a-probe: Q2)
//
// The chunk-11 goal is mesh bytes through a Tension Volume. The mesh bytes are
// easy — they arrive as a MemoryDataStream and the v1 -> v2 conversion never
// touches a file for them. The skeleton is the part that goes through OGRE's
// own resource machinery: `backend_ogre.cpp`'s comment (and chunk 5b's
// measurement) says the conversion resolves a skeleton *by name* within a
// resource group, and today that is made to work by registering the media
// directory as a FileSystem resource location. A TNS is not an Ogre::Archive,
// so if a volume-only pipeline is to carry Stickman, the skeleton has to enter
// OGRE without a file.
//
// OGRE-Next 3.0 has no `SkeletonManager::create(name, group, isManual, loader)`
// — its v2 SkeletonManager only has getSkeletonDef()/add(). The legacy manager
// does: `Ogre::v1::OldSkeletonManager::create(name, group, isManual, loader)`
// with a `ManualResourceLoader` whose loadResource() imports the skeleton
// bytes. This probe measures whether that registration satisfies the
// conversion's lookup with **no resource location registered at all**.
//
// Arms (one per process run, so a crash or a throw cannot contaminate another):
//   default      create the manual v1 skeleton, import the mesh (no preload)
//   --preload    create, then skeleton->load() (fire the loader) before import
//   --warm       also call v2 SkeletonManager::getSkeletonDef(name, group)
//                before the import (isolates the v2-side lookup)
//   --manual=0   control: no registration; measures what the conversion does
//                when the skeleton is nowhere
//
// Build (same flags as probe_skinning):
//   g++ -std=c++17 -O1 -isystem /usr/include/OGRE-Next \
//       -isystem /usr/include/OGRE-Next/Hlms/Common \
//       -isystem /usr/include/OGRE-Next/Hlms/Unlit \
//       -isystem /usr/include/OGRE-Next/Hlms/Pbs \
//       tests/probe_skeleton_tns.cpp -o build/probe-skeleton-tns/probe_skeleton_tns \
//       -lOgreNextMain -lOgreNextHlmsUnlit -lOgreNextHlmsPbs -lpthread
//   ./probe_skeleton_tns /usr/lib/OGRE-Next [--preload] [--warm] [--manual=0]

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
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <iterator>
#include <string>
#include <vector>

namespace {

const char *const kMedia = "/usr/share/OGRE-Next/Media";
const char *const kGroup = "Tension";  // the adapter's own resource group
const char *const kFileBase = "Stickman";          // the file names on disk
const char *const kSkeletonName = "Stickman.skeleton";  // what the mesh's own
// skeleton reference says (mesh->getSkeletonName() measures it): the lookup
// is by exactly this string, so the manual resource must carry it too.
const char *const kMeshName = "Stickman";           // our name for the v2 mesh
const uint32_t kWindowWidth = 320;
const uint32_t kWindowHeight = 240;

std::vector<uint8_t> read_file(const std::string &path) {
    std::ifstream file(path, std::ios::binary);
    return std::vector<uint8_t>(std::istreambuf_iterator<char>(file),
                                std::istreambuf_iterator<char>());
}

double now_us() {
    using clock = std::chrono::steady_clock;
    return std::chrono::duration<double, std::micro>(clock::now().time_since_epoch()).count();
}

// ── the fileless skeleton: a ManualResourceLoader over pre-loaded bytes ──
// The loader must outlive the resource (OGRE may call it on any reload), so it
// lives in main()'s scope and the resource is freed with the process.

struct SkeletonBytes : public Ogre::ManualResourceLoader {
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
    // Background from the frame's own top-left pixel, not "darker than 40": a
    // mesh drawn black and a mesh not drawn at all are the same number under a
    // brightness rule, which is the ambiguity probe_skinning documented.
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

void pose_bone(Ogre::SkeletonInstance *skeleton, size_t index, float angle_degrees) {
    Ogre::Bone *bone = skeleton->getBone(index);
    const float radians = angle_degrees * 3.14159265358979f / 180.0f;
    bone->setOrientation(Ogre::Quaternion(Ogre::Radian(radians), Ogre::Vector3::UNIT_X));
    bone->setPosition(Ogre::Vector3::ZERO);
    bone->setScale(Ogre::Vector3::UNIT_SCALE);
}

} // namespace

int main(int argc, char **argv) {
    std::setvbuf(stdout, nullptr, _IONBF, 0);
    if (argc < 2) {
        std::fprintf(stderr, "usage: probe_skeleton_tns <plugin-dir> [--preload] [--warm] "
                             "[--manual=0]\n");
        return 2;
    }
    const std::string plugin_dir = argv[1];
    bool manual = true, preload = false, warm = false;
    for (int i = 2; i < argc; ++i) {
        const std::string arg = argv[i];
        if (arg == "--preload") preload = true;
        if (arg == "--warm") warm = true;
        if (arg == "--manual=0") manual = false;
    }

    {
        std::ofstream cfg("skeleton_tns_plugins.cfg");
        cfg << "PluginFolder=" << plugin_dir << "\n"
            << "Plugin=RenderSystem_GL3Plus\n";
    }
    Ogre::LogManager *logs = new Ogre::LogManager();
    logs->createLog("skeleton_tns_probe.log", true, false);

    Ogre::Root root(nullptr, "skeleton_tns_plugins.cfg", "skeleton_tns_probe.cfg",
                    "skeleton_tns_probe.log", "skeleton-tns");
    Ogre::RenderSystem *rs = root.getRenderSystemByName("OpenGL 3+ Rendering Subsystem");
    if (rs == nullptr) {
        std::printf("TNS-SKEL: the GL3+ render system is not in this install\n");
        return 2;
    }
    root.setRenderSystem(rs);
    root.initialise(false);

    Ogre::NameValuePairList params;
    params["width"] = std::to_string(kWindowWidth);
    params["height"] = std::to_string(kWindowHeight);
    Ogre::Window *window =
        root.createRenderWindow("skeleton-tns-probe", kWindowWidth, kWindowHeight, false, &params);
    Ogre::SceneManager *scene = root.createSceneManager(Ogre::ST_GENERIC, 1u, "skeleton-tns-mgr");
    scene->setForwardClustered(true, 16u, 8u, 24u, 96u, 2u, 0u, 0.0f, 100000.0f);

    Ogre::Camera *camera = scene->createCamera("skeleton-tns-camera");
    camera->setPosition(0.0f, 0.0f, 4.0f);
    camera->lookAt(0.0f, 0.0f, 0.0f);
    camera->setNearClipDistance(0.1f);
    camera->setAutoAspectRatio(true);

    Ogre::CompositorManager2 *compositors = root.getCompositorManager2();
    compositors->createBasicWorkspaceDef("skeleton-tns-workspace",
                                         Ogre::ColourValue(0.1f, 0.1f, 0.1f, 1.0f));
    if (compositors->addWorkspace(scene, window->getTexture(), camera, "skeleton-tns-workspace",
                                  true) == nullptr) {
        std::printf("TNS-SKEL: the workspace was refused\n");
        return 2;
    }
    Downloader downloader;
    downloader.window = window;
    root.addFrameListener(&downloader);

    std::printf("TNS-SKEL Q2: does a manual, fileless skeleton satisfy the v1->v2 conversion?\n");
    std::printf("TNS-SKEL arm: manual=%d preload=%d warm=%d\n", manual ? 1 : 0, preload ? 1 : 0,
                warm ? 1 : 0);

    // A group has to exist before anything can be created in it — the first
    // run of this probe died in OldSkeletonManager::create with
    // "Cannot find a group named Tension in ResourceGroupManager::
    // isResourceGroupInitialised". The adapter gets its group as a side effect
    // of addResourceLocation; a TNS-only pipeline has no location to add, so it
    // creates the group empty. The group existing and the filesystem being
    // reachable are two different things, and only the first one is required.
    {
        Ogre::ResourceGroupManager &rgm = Ogre::ResourceGroupManager::getSingleton();
        if (!rgm.resourceGroupExists(kGroup)) rgm.createResourceGroup(kGroup);
        rgm.initialiseResourceGroup(Ogre::String(kGroup), /* changeLocaleTemporarily */ false);
        std::printf("TNS-SKEL: group \"%s\" exists (empty, %s locations) — no resource location "
                    "is registered in this probe, that is the point\n",
                    kGroup, "zero");
    }

    // ── the bytes, both read from disk into memory ───────────────────────
    const std::vector<uint8_t> mesh_bytes =
        read_file(std::string(kMedia) + "/models/" + kFileBase + ".mesh");
    std::vector<uint8_t> skeleton_bytes =
        read_file(std::string(kMedia) + "/models/" + kFileBase + ".skeleton");
    std::printf("TNS-SKEL: mesh bytes %zu, skeleton bytes %zu (in memory, no file left behind)\n",
                mesh_bytes.size(), skeleton_bytes.size());
    if (mesh_bytes.empty() || skeleton_bytes.empty()) {
        std::printf("TNS-SKEL: the media tree is not where this probe expects it\n");
        return 2;
    }

    // ── the registerable Pbs Hlms (shader templates, not the skeleton) ────
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

    // ── registration (or the control's pointed absence) ──────────────────
    SkeletonBytes loader;
    loader.bytes = skeleton_bytes;
    Ogre::v1::SkeletonPtr skeleton;
    if (manual) {
        skeleton = Ogre::v1::OldSkeletonManager::getSingleton().create(
            kSkeletonName, kGroup, /* isManual */ true, &loader);
        std::printf("Q2 registered: v1::OldSkeletonManager::create(\"%s\", \"%s\", isManual=true, "
                    "loader) -> \"%s\" (isLoaded=%s, loader calls so far %zu)\n",
                    kSkeletonName, kGroup, skeleton->getName().c_str(),
                    skeleton->isLoaded() ? "yes" : "no", loader.load_calls);
        if (preload) {
            skeleton->load();
            std::printf("Q2 preload: skeleton->load() -> isLoaded=%s, v1 bones=%zu, loader calls "
                        "%zu\n",
                        skeleton->isLoaded() ? "yes" : "no", skeleton->getNumBones(),
                        loader.load_calls);
        }
        if (warm) {
            try {
                Ogre::SkeletonDefPtr def =
                    Ogre::SkeletonManager::getSingleton().getSkeletonDef(kSkeletonName, kGroup);
                std::printf("Q2 warm: v2 getSkeletonDef(\"%s\", \"%s\") -> %s\n", kSkeletonName,
                            kGroup, def ? "a def" : "null");
            } catch (const std::exception &e) {
                std::printf("Q2 warm: v2 getSkeletonDef threw: %s\n", e.what());
            }
        }
    } else {
        std::printf("Q2 registered: NOTHING (control arm: no skeleton, no resource location)\n");
    }

    // ── the conversion, call by call so the throw names its step ─────────
    Ogre::MeshPtr mesh;
    bool converted = false;
    {
        Ogre::DataStreamPtr stream(new Ogre::MemoryDataStream(
            const_cast<uint8_t *>(mesh_bytes.data()), mesh_bytes.size(), false, /* readOnly */ true));
        Ogre::v1::MeshPtr v1 = Ogre::v1::MeshManager::getSingleton().createManual(
            std::string(kMeshName) + "-v1", kGroup);
        Ogre::v1::MeshSerializer serializer;
        std::printf("Q2 conversion:\n");
        try {
            serializer.importMesh(stream, v1.get());
            std::printf("  importMesh: ok (v1 mesh, %u submeshes)\n", v1->getNumSubMeshes());
        } catch (const std::exception &e) {
            std::printf("  importMesh: FAILED: %s\n", e.what());
        }
        try {
            mesh = Ogre::MeshManager::getSingleton().createByImportingV1(
                kMeshName, kGroup, v1.get(), false, false, false);
            converted = true;
            std::printf("  createByImportingV1: ok\n");
        } catch (const std::exception &e) {
            std::printf("  createByImportingV1: THREW: %s\n", e.what());
        }
        if (converted) {
            try {
                mesh->load();
                std::printf("  mesh->load(): ok\n");
            } catch (const std::exception &e) {
                converted = false;
                std::printf("  mesh->load(): THREW: %s\n", e.what());
            }
        }
    }

    if (!converted) {
        std::printf("Q2 verdict: manual skeleton found=%s (the conversion did not complete)\n",
                    manual ? "NO" : "n/a (control)");
        if (manual) std::printf("TNS-SKEL: the decision point — report and stop; partial migration "
                                "is the fallback\n");
        return manual ? 3 : 0;
    }

    if (manual) {
        std::printf("Q2 loader: %zu loadResource call(s) so far, v1 resource isLoaded=%s — "
                    "the conversion's lookup %s\n",
                    loader.load_calls, skeleton->isLoaded() ? "yes" : "no",
                    loader.load_calls > 0 ? "fired the loader by itself (no preload needed)"
                                          : "did NOT fire the loader");
    }
    const bool rigged = mesh->hasSkeleton();
    size_t bones = 0;
    if (rigged && mesh->getSkeleton()) bones = mesh->getSkeleton()->getBones().size();
    std::printf("Q2 conversion result: hasSkeleton=%s bones=%zu skeletonName=\"%s\" submeshes=%u\n",
                rigged ? "true" : "false", bones, mesh->getSkeletonName().c_str(),
                mesh->getNumSubMeshes());
    if (!rigged || mesh->getSkeleton() == nullptr) {
        std::printf("Q2 verdict: manual skeleton found=%s (the mesh came back %s)\n",
                    manual ? "NO" : "n/a (control)",
                    rigged ? "rigged but with no def" : "unrigged");
        // The rigged-but-empty case is chunk 5b's SIGSEGV class; do not draw it.
        return manual ? 3 : 0;
    }

    // ── draw it, pose a bone, and measure whether it skins ───────────────
    Ogre::HlmsMacroblock macroblock;
    Ogre::HlmsBlendblock blendblock;
    Ogre::HlmsParamVec param_vec;
    auto *datablock = static_cast<Ogre::HlmsPbsDatablock *>(
        pbs->createDatablock("tns-skin", "tns-skin", macroblock, blendblock, param_vec));
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

    // Frame the figure by its own bounds, so the skinning measurement has a
    // silhouette to move: a 174-pixel Stickman is real but the flip numbers it
    // produces are not evidence anyone should read.
    float scale = 0.02f;
    {
        const Ogre::Aabb bounds = item->getWorldAabb();
        const float height = bounds.getMaximum().y - bounds.getMinimum().y;
        const float fitted = height > 0.001f ? 2.5f / height : 0.02f;
        node->setScale(fitted, fitted, fitted);
        for (int settle = 0; settle < 3; ++settle) root.renderOneFrame();
        Frame try_frame;
        const size_t pixels = grab(&root, downloader, try_frame) ? non_background(try_frame) : 0;
        std::printf("Q2 framing: bounds height %.2f -> scale %.4f, %zu non-background px%s\n",
                    static_cast<double>(height), static_cast<double>(fitted), pixels,
                    pixels >= 100 && pixels <= 70000 ? "  <- using this" : "");
        if (pixels >= 100 && pixels <= 70000) {
            scale = fitted;
        } else {
            for (float candidate : {0.02f, 0.2f, 1.0f}) {
                node->setScale(candidate, candidate, candidate);
                for (int settle = 0; settle < 3; ++settle) root.renderOneFrame();
                Frame fallback;
                const size_t n = grab(&root, downloader, fallback) ? non_background(fallback) : 0;
                std::printf("Q2 at scale %.2f the mesh covers %zu non-background pixels%s\n",
                            static_cast<double>(candidate), n,
                            n > 40 && n < 70000 ? "  <- using this" : "");
                if (n > 40 && n < 70000) {
                    scale = candidate;
                    break;
                }
            }
        }
    }
    node->setScale(scale, scale, scale);
    for (int settle = 0; settle < 3; ++settle) root.renderOneFrame();

    Ogre::SkeletonInstance *skeleton_instance = item->getSkeletonInstance();
    std::printf("Q2 item: skeleton instance %s\n",
                skeleton_instance ? "present" : "MISSING (the item came back unskinned)");
    if (skeleton_instance == nullptr) {
        std::printf("Q2 verdict: manual skeleton found=YES but the item is unskinned\n");
        return 3;
    }
    std::printf("Q2 item: %zu bones on the instance\n", skeleton_instance->getNumBones());

    Frame rest;
    if (!grab(&root, downloader, rest)) {
        std::printf("Q2: the rest frame could not be captured\n");
        return 3;
    }
    std::printf("Q2 rest: %zu non-background px\n", non_background(rest));

    const size_t tries = std::min<size_t>(6, skeleton_instance->getNumBones());
    double best_flip = -1.0;
    size_t best_bone = 0;
    size_t best_pixels = 0;
    for (size_t i = 0; i < tries; ++i) {
        pose_bone(skeleton_instance, i, 30.0f);
        for (int settle = 0; settle < 3; ++settle) root.renderOneFrame();
        Frame posed;
        if (grab(&root, downloader, posed)) {
            const double flip = flip_fraction(rest, posed);
            std::printf("  bone %2zu %-18s flip %.5f  non-bg %zu\n", i,
                        skeleton_instance->getBone(i)->getName().c_str(), flip,
                        non_background(posed));
            if (flip > best_flip) {
                best_flip = flip;
                best_bone = i;
                best_pixels = non_background(posed);
            }
        } else {
            std::printf("  bone %2zu could not be captured\n", i);
        }
        pose_bone(skeleton_instance, i, 0.0f);
        for (int settle = 0; settle < 2; ++settle) root.renderOneFrame();
    }
    std::printf("Q2 verdict: manual skeleton found=YES skins=%s (best flip %.5f on bone %zu "
                "\"%s\", non-bg %zu)\n",
                best_flip > 0.0 ? "YES" : "NO", best_flip, best_bone,
                skeleton_instance->getBone(best_bone)->getName().c_str(), best_pixels);
    return best_flip > 0.0 ? 0 : 3;
}
