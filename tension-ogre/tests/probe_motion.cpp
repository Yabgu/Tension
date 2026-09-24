// probe_motion.cpp — two measurements taken before anything is written against
// them (chunk 4, round 4a).
//
//   P1 (default) — what does it cost to move M items every frame, under GL3+?
//       M items in a grid, a static phase and a moving phase, the per-frame CPU
//       cost of the transform pass and of renderOneFrame(), the achieved rate,
//       and proof that nothing was re-created and the transforms landed.
//
//   P2 (--calibrate) — where does the barrel land on screen at a known world X?
//       One item at x = 0, +0.25, +0.5; the centroid of its non-background
//       pixels at each. The differences are the measured pixels-per-unit that
//       the chunk-4 acid test's tolerance is written against.
//
// Committed as a probe, like probe_loader/probe_ogre/probe_scene before it: the
// numbers in the round's report come from this binary and nothing in the adapter
// imports it.
//
//   g++ -std=c++17 -O1 -isystem /usr/include/OGRE-Next \
//       -isystem /usr/include/OGRE-Next/Hlms/Common \
//       -isystem /usr/include/OGRE-Next/Hlms/Unlit \
//       -isystem /usr/include/OGRE-Next/Hlms/Pbs \
//       tests/probe_motion.cpp -o build/probe-motion/probe_motion \
//       -lOgreNextMain -lOgreNextHlmsUnlit -lOgreNextHlmsPbs -lpthread
//   ./probe_motion /usr/lib/OGRE-Next [--bodies=256] [--frames=60] [--calibrate]

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
#include <OgreRoot.h>
#include <OgreSceneManager.h>
#include <OgreSceneNode.h>
#include <OgreTextureBox.h>
#include <OgreTextureGpu.h>
#include <OgreWindow.h>

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

/// The window, camera and object size the 3b triangle fixture uses, so P2's
/// calibration is the number that fixture can be written against.
const uint32_t kWindowWidth = 320;
const uint32_t kWindowHeight = 240;
const float kBarrelScale = 0.02f;

std::vector<uint8_t> read_file(const std::string &path) {
    std::ifstream file(path, std::ios::binary);
    return std::vector<uint8_t>(std::istreambuf_iterator<char>(file),
                                std::istreambuf_iterator<char>());
}

double now_us() {
    using clock = std::chrono::steady_clock;
    return std::chrono::duration<double, std::micro>(clock::now().time_since_epoch()).count();
}

// ── the readback ─────────────────────────────────────────────────────────
//
// The frame listener, not the manual-swap-release sequence: round 3b-ii
// measured the manual path downloading an all-black image about one run in
// five, and this probe takes three frames in a row.

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
        if (!window->canDownloadData()) return true; // not yet: next frame
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

/// Render until the listener has a frame. An all-black frame is the download
/// race 3b-ii diagnosed, not an empty scene, so it is asked for again.
bool grab(Ogre::Root *root, Downloader &downloader) {
    for (int attempt = 0; attempt < 3; ++attempt) {
        downloader.ready = false;
        downloader.wanted = true;
        downloader.window->setWantsToDownload(true);
        for (int i = 0; i < 16 && !downloader.ready; ++i) root->renderOneFrame();
        if (!downloader.ready) continue;
        const Frame &frame = downloader.frame;
        for (size_t i = 0; i + 2 < frame.pixels.size(); i += 4) {
            if (frame.pixels[i] || frame.pixels[i + 1] || frame.pixels[i + 2]) return true;
        }
    }
    return false;
}

struct Centroid {
    size_t count = 0;
    double x = 0, y = 0;
};

/// The probe's background rule, the same one probe_scene and the 3b fixture
/// use: every channel below 40 is the workspace's clear colour.
Centroid centroid_of(const Frame &frame) {
    Centroid result;
    double sum_x = 0, sum_y = 0;
    for (uint32_t y = 0; y < frame.height; ++y) {
        const uint8_t *row =
            frame.pixels.data() + static_cast<size_t>(y) * frame.width * frame.bpp;
        for (uint32_t x = 0; x < frame.width; ++x) {
            const uint8_t *p = row + static_cast<size_t>(x) * frame.bpp;
            if (p[0] < 40 && p[1] < 40 && p[2] < 40) continue;
            result.count += 1;
            sum_x += x;
            sum_y += y;
        }
    }
    if (result.count > 0) {
        result.x = sum_x / static_cast<double>(result.count);
        result.y = sum_y / static_cast<double>(result.count);
    }
    return result;
}

int usage() {
    std::fprintf(stderr,
                 "usage: probe_motion <plugin-dir> [--bodies=M] [--frames=F] "
                 "[--calibrate]\n");
    return 2;
}

} // namespace

int main(int argc, char **argv) {
    std::setvbuf(stdout, nullptr, _IONBF, 0);
    if (argc < 2) return usage();

    const std::string plugin_dir = argv[1];
    int bodies = 256;
    int frames = 60;
    bool calibrate = false;
    for (int i = 2; i < argc; ++i) {
        const std::string arg = argv[i];
        if (arg == "--calibrate") {
            calibrate = true;
        } else if (arg.rfind("--bodies=", 0) == 0) {
            bodies = std::atoi(arg.c_str() + 9);
        } else if (arg.rfind("--frames=", 0) == 0) {
            frames = std::atoi(arg.c_str() + 9);
        } else {
            return usage();
        }
    }
    if (bodies < 1 || frames < 1) return usage();

    {
        std::ofstream cfg("motion_plugins.cfg");
        cfg << "PluginFolder=" << plugin_dir << "\n"
            << "Plugin=RenderSystem_GL3Plus\n";
    }
    Ogre::LogManager *logs = new Ogre::LogManager();
    logs->createLog("motion_probe.log", true, false);

    Ogre::Root root(nullptr, "motion_plugins.cfg", "motion_probe.cfg", "motion_probe.log",
                    "motion");
    Ogre::RenderSystem *rs = root.getRenderSystemByName("OpenGL 3+ Rendering Subsystem");
    if (rs == nullptr) {
        std::printf("MOTION: the GL3+ render system is not in this install\n");
        return 2;
    }
    root.setRenderSystem(rs);
    root.initialise(false);

    Ogre::NameValuePairList params;
    params["width"] = std::to_string(kWindowWidth);
    params["height"] = std::to_string(kWindowHeight);
    Ogre::Window *window =
        root.createRenderWindow("motion-probe", kWindowWidth, kWindowHeight, false, &params);
    Ogre::SceneManager *scene = root.createSceneManager(Ogre::ST_GENERIC, 1u, "motion-probe-mgr");

    Ogre::Camera *camera = scene->createCamera("motion-camera");
    camera->setPosition(0.0f, 0.0f, 4.0f);
    camera->lookAt(0.0f, 0.0f, 0.0f);
    camera->setNearClipDistance(0.1f);
    camera->setAutoAspectRatio(true);

    Ogre::CompositorManager2 *compositors = root.getCompositorManager2();
    compositors->createBasicWorkspaceDef("motion-workspace", Ogre::ColourValue(0.1f, 0.1f, 0.1f, 1.0f));
    if (compositors->addWorkspace(scene, window->getTexture(), camera, "motion-workspace", true) ==
        nullptr) {
        std::printf("MOTION: the workspace was refused\n");
        return 2;
    }

    // ── the mesh, by the 3a recipe ──────────────────────────────────────
    Ogre::MeshPtr mesh;
    try {
        const std::vector<uint8_t> bytes = read_file(std::string(kMedia) + "/models/Barrel.mesh");
        if (bytes.empty()) throw std::runtime_error("Barrel.mesh could not be read");
        Ogre::DataStreamPtr stream(new Ogre::MemoryDataStream(
            const_cast<uint8_t *>(bytes.data()), bytes.size(), false, true));
        Ogre::v1::MeshPtr v1 =
            Ogre::v1::MeshManager::getSingleton().createManual("motion-v1", kGroup);
        Ogre::v1::MeshSerializer serializer;
        serializer.importMesh(stream, v1.get());
        mesh = Ogre::MeshManager::getSingleton().createByImportingV1("motion-mesh", kGroup,
                                                                     v1.get(), false, false, false);
        mesh->load();
    } catch (const std::exception &e) {
        std::printf("MOTION: the mesh reported: %s\n", e.what());
        return 3;
    }

    Ogre::HlmsUnlit *unlit = nullptr;
    Ogre::HlmsUnlitDatablock *datablock = nullptr;
    try {
        Ogre::ArchiveManager &archives = Ogre::ArchiveManager::getSingleton();
        Ogre::Archive *sources =
            archives.load(std::string(kMedia) + "/Hlms/Unlit/GLSL", "FileSystem", true);
        Ogre::Archive *pbs_sources =
            archives.load(std::string(kMedia) + "/Hlms/Pbs/GLSL", "FileSystem", true);
        Ogre::ArchiveVec library;
        library.push_back(archives.load(std::string(kMedia) + "/Hlms/Common/GLSL", "FileSystem", true));
        library.push_back(archives.load(std::string(kMedia) + "/Hlms/Common/Any", "FileSystem", true));
        library.push_back(archives.load(std::string(kMedia) + "/Hlms/Unlit/Any", "FileSystem", true));
        library.push_back(archives.load(std::string(kMedia) + "/Hlms/Pbs/Any", "FileSystem", true));
        unlit = new Ogre::HlmsUnlit(sources, &library);
        // Both Hlms, not just the one this probe's datablock comes from.
        // Measured: Barrel.mesh's sub-items name `RustyBarrel`, OGRE routes an
        // unknown material name to the PBS Hlms, and with PBS unregistered
        // `createItem` segfaults inside Hlms::getDefaultDatablock rather than
        // refusing. The adapter registers both for the same reason.
        Ogre::HlmsPbs *pbs = new Ogre::HlmsPbs(pbs_sources, &library);
        root.getHlmsManager()->registerHlms(unlit);
        root.getHlmsManager()->registerHlms(pbs);
        Ogre::HlmsMacroblock macroblock;
        Ogre::HlmsBlendblock blendblock;
        Ogre::HlmsParamVec param_vec;
        datablock = static_cast<Ogre::HlmsUnlitDatablock *>(
            unlit->createDatablock("motion-red", "motion-red", macroblock, blendblock, param_vec));
        datablock->setUseColour(true);
        datablock->setColour(Ogre::ColourValue(0.9f, 0.2f, 0.2f, 1.0f));
    } catch (const std::exception &e) {
        std::printf("MOTION: the Hlms reported: %s\n", e.what());
        return 4;
    }

    Downloader downloader;
    downloader.window = window;
    root.addFrameListener(&downloader);

    // ── P2: the calibration ─────────────────────────────────────────────
    if (calibrate) {
        Ogre::Item *item = scene->createItem(mesh, Ogre::SCENE_DYNAMIC);
        item->setDatablock(datablock);
        Ogre::SceneNode *node =
            scene->getRootSceneNode(Ogre::SCENE_DYNAMIC)->createChildSceneNode(Ogre::SCENE_DYNAMIC);
        node->attachObject(item);
        node->setScale(kBarrelScale, kBarrelScale, kBarrelScale);

        const float positions[] = {0.0f, 0.25f, 0.5f};
        double measured[3] = {0, 0, 0};
        size_t counts[3] = {0, 0, 0};
        std::printf("MOTION P2: %ux%u, camera z=4 fovY=%.1f deg, barrel scale %.3f\n",
                    window->getWidth(), window->getHeight(), camera->getFOVy().valueDegrees(),
                    static_cast<double>(kBarrelScale));
        for (int i = 0; i < 3; ++i) {
            node->setPosition(positions[i], 0.0f, 0.0f);
            for (int settle = 0; settle < 3; ++settle) root.renderOneFrame();
            if (!grab(&root, downloader)) {
                std::printf("MOTION P2: no frame could be downloaded at x=%.2f\n",
                            static_cast<double>(positions[i]));
                return 5;
            }
            const Centroid c = centroid_of(downloader.frame);
            measured[i] = c.x;
            counts[i] = c.count;
            std::printf("  x=%+.2f -> centroid x %.2f px, y %.2f px, %zu non-background px\n",
                        static_cast<double>(positions[i]), c.x, c.y, c.count);
        }
        const double per_unit_a = (measured[1] - measured[0]) / 0.25;
        const double per_unit_b = (measured[2] - measured[1]) / 0.25;
        const double mean = (per_unit_a + per_unit_b) / 2.0;
        const double analytic = 72.4;
        std::printf("  px-per-unit: %.2f and %.2f, mean %.2f (analytic %.1f, %.1f%% off)\n",
                    per_unit_a, per_unit_b, mean, analytic,
                    100.0 * (mean - analytic) / analytic);
        std::printf("  units-per-px: %.5f\n", 1.0 / mean);
        return 0;
    }

    // ── P1: the cost of moving M items ──────────────────────────────────
    const int cols = static_cast<int>(std::ceil(std::sqrt(static_cast<double>(bodies))));
    const int rows = (bodies + cols - 1) / cols;
    const float spacing_x = 0.25f;
    const float spacing_y = 0.2f;

    std::vector<Ogre::Item *> items;
    std::vector<Ogre::SceneNode *> nodes;
    std::vector<float> base_x, base_y;
    items.reserve(static_cast<size_t>(bodies));
    nodes.reserve(static_cast<size_t>(bodies));
    base_x.reserve(static_cast<size_t>(bodies));
    base_y.reserve(static_cast<size_t>(bodies));

    for (int i = 0; i < bodies; ++i) {
        const int cx = i % cols, cy = i / cols;
        Ogre::Item *item = scene->createItem(mesh, Ogre::SCENE_DYNAMIC);
        item->setDatablock(datablock);
        Ogre::SceneNode *node = scene->getRootSceneNode(Ogre::SCENE_DYNAMIC)
                                    ->createChildSceneNode(Ogre::SCENE_DYNAMIC);
        node->attachObject(item);
        node->setScale(kBarrelScale, kBarrelScale, kBarrelScale);
        const float x = (static_cast<float>(cx) - (cols - 1) * 0.5f) * spacing_x;
        const float y = (static_cast<float>(cy) - (rows - 1) * 0.5f) * spacing_y;
        node->setPosition(x, y, 0.0f);
        items.push_back(item);
        nodes.push_back(node);
        base_x.push_back(x);
        base_y.push_back(y);
    }

    const size_t children_before = scene->getRootSceneNode(Ogre::SCENE_DYNAMIC)->numChildren();
    for (int i = 0; i < 3; ++i) root.renderOneFrame(); // settle
    const float aabb_before = items[0]->getWorldAabb().getMinimum().x;

    // The static phase: frames with no transform work, so the moving phase's
    // renderOneFrame() cost has a baseline to be compared against.
    double static_render = 0, static_render_max = 0;
    for (int frame = 0; frame < frames; ++frame) {
        const double t0 = now_us();
        root.renderOneFrame();
        const double dt = now_us() - t0;
        static_render += dt;
        static_render_max = std::max(static_render_max, dt);
    }

    double move_total = 0, move_max = 0, render_total = 0, render_max = 0;
    const double wall_start = now_us();
    for (int frame = 0; frame < frames; ++frame) {
        const float dx = 0.2f * std::sin(static_cast<float>(frame) * 0.1f);
        const double t0 = now_us();
        for (size_t i = 0; i < nodes.size(); ++i) {
            nodes[i]->setPosition(base_x[i] + dx, base_y[i], 0.0f);
        }
        const double t1 = now_us();
        root.renderOneFrame();
        const double t2 = now_us();
        move_total += t1 - t0;
        move_max = std::max(move_max, t1 - t0);
        render_total += t2 - t1;
        render_max = std::max(render_max, t2 - t1);
    }
    const double wall = now_us() - wall_start;

    const size_t children_after = scene->getRootSceneNode(Ogre::SCENE_DYNAMIC)->numChildren();
    const float aabb_after = items[0]->getWorldAabb().getMinimum().x;
    const float expected_dx =
        0.2f * std::sin(static_cast<float>(frames - 1) * 0.1f);

    std::printf("MOTION P1: bodies=%d frames=%d grid=%dx%d\n", bodies, frames, cols, rows);
    std::printf("  transform pass:  mean %7.1f us/frame, max %7.1f us\n",
                move_total / frames, move_max);
    std::printf("  renderOneFrame:  mean %7.1f us/frame, max %7.1f us (static mean %.1f us)\n",
                render_total / frames, render_max, static_render / frames);
    std::printf("  static render:   mean %7.1f us/frame, max %7.1f us\n",
                static_render / frames, static_render_max);
    std::printf("  achieved:        %7.1f fps over %.3f s (%d frames)\n",
                frames / (wall / 1e6), wall / 1e6, frames);
    std::printf("  children:        %zu before, %zu after (nothing re-created)\n", children_before,
                children_after);
    std::printf("  item[0] world aabb min x: %.4f -> %.4f (moved %.4f, expected %.4f)\n",
                static_cast<double>(aabb_before), static_cast<double>(aabb_after),
                static_cast<double>(aabb_after - aabb_before),
                static_cast<double>(expected_dx));
    return 0;
}
