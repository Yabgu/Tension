// probe_scene.cpp — what does a scene actually require on this install?
//
// Round 3b-i runs this before anything is written against it, because round
// 3a's two probes saved three rewrites. Each question is its own step:
//
//   1. Root + window + scene manager + workspace (the 2b path)
//   2. HlmsUnlit/HlmsPbs construction: does the manager want archives, and do
//      the shader templates have to be reachable before a datablock is made?
//   3. an Unlit datablock with a colour, and one with a texture
//   4. a Mesh2 -> Item, and the attach call
//   5. a camera, and replacing the workspace's camera
//   6. thirty frames with all of it live
//   7. readback: the window header's documented screenshot sequence
//
//   g++ -std=c++17 -O1 -isystem /usr/include/OGRE-Next tests/probe_scene.cpp \
//       -o build/probe-scene/probe_scene -lOgreNextMain -lpthread
//   ./probe_scene /usr/lib/OGRE-Next [--gl3plus]

#include <OgreArchiveManager.h>
#include <OgreCamera.h>
#include <OgreColourValue.h>
#include <OgreDataStream.h>
#include <OgreException.h>
#include <OgreHlmsDatablock.h>
#include <OgreHlmsManager.h>
#include <OgreImage2.h>
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
#include <OgreTextureGpuManager.h>
#include <OgreWindow.h>

#include <Compositor/OgreCompositorManager2.h>
#include <Compositor/OgreCompositorWorkspace.h>
#include <Hlms/Pbs/OgreHlmsPbs.h>
#include <Hlms/Unlit/OgreHlmsUnlit.h>
#include <Hlms/Unlit/OgreHlmsUnlitDatablock.h>

#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <iterator>
#include <string>
#include <vector>

namespace {

const char *const kMedia = "/usr/share/OGRE-Next/Media";
const char *const kGroup = "General";
int step = 0;
int failures = 0;

void ok(const std::string &what) { std::printf("SCENE step %d: ok — %s\n", step, what.c_str()); }

void failed(const std::string &where, const std::string &why) {
    std::printf("SCENE step %d: FAILED (%s) — %s\n", step, where.c_str(), why.c_str());
    failures += 1;
}

std::vector<uint8_t> read_file(const std::string &path) {
    std::ifstream file(path, std::ios::binary);
    return std::vector<uint8_t>(std::istreambuf_iterator<char>(file),
                                std::istreambuf_iterator<char>());
}

struct PixelStats {
    size_t non_background = 0;
    float mean_r = 0, mean_g = 0, mean_b = 0;
    uint32_t corner_r = 0, corner_g = 0, corner_b = 0;
};

PixelStats scan(const Ogre::TextureBox &box) {
    PixelStats stats;
    double sum[3] = {0, 0, 0};
    const uint8_t *pixels = static_cast<const uint8_t *>(box.data);
    for (uint32_t y = 0; y < box.height; ++y) {
        const uint8_t *row = pixels + y * box.bytesPerRow;
        for (uint32_t x = 0; x < box.width; ++x) {
            const uint8_t *p = row + x * box.bytesPerPixel;
            const bool background = p[0] < 40 && p[1] < 40 && p[2] < 40; // 0.1 in 8-bit
            if (!background) {
                stats.non_background += 1;
                sum[0] += p[0];
                sum[1] += p[1];
                sum[2] += p[2];
            }
            if (x == 0 && y == 0) {
                stats.corner_r = p[0];
                stats.corner_g = p[1];
                stats.corner_b = p[2];
            }
        }
    }
    if (stats.non_background > 0) {
        stats.mean_r = static_cast<float>(sum[0] / static_cast<double>(stats.non_background));
        stats.mean_g = static_cast<float>(sum[1] / static_cast<double>(stats.non_background));
        stats.mean_b = static_cast<float>(sum[2] / static_cast<double>(stats.non_background));
    }
    return stats;
}

} // namespace

int main(int argc, char **argv) {
    std::setvbuf(stdout, nullptr, _IONBF, 0);
    const std::string plugin_dir = argc > 1 ? argv[1] : "/usr/lib/OGRE-Next";
    bool gl3plus = false;
    for (int i = 2; i < argc; ++i) {
        if (std::string(argv[i]) == "--gl3plus") gl3plus = true;
    }

    {
        std::ofstream cfg("scene_plugins.cfg");
        cfg << "PluginFolder=" << plugin_dir << "\n"
            << (gl3plus ? "Plugin=RenderSystem_GL3Plus\n" : "Plugin=RenderSystem_NULL\n");
    }
    Ogre::LogManager *logs = new Ogre::LogManager();
    logs->createLog("scene_probe.log", true, false);

    Ogre::Root root(nullptr, "scene_plugins.cfg", "scene_probe.cfg", "scene_probe.log", "scene");
    const char *rs_name = gl3plus ? "OpenGL 3+ Rendering Subsystem" : "NULL Rendering Subsystem";
    Ogre::RenderSystem *rs = root.getRenderSystemByName(rs_name);
    if (!rs) {
        std::printf("SCENE: no render system named %s\n", rs_name);
        return 2;
    }
    std::printf("SCENE: render system '%s'\n", rs_name);
    root.setRenderSystem(rs);
    root.initialise(false);
    Ogre::Window *window = root.createRenderWindow("scene-probe", 320, 240, false, nullptr);
    Ogre::SceneManager *scene = root.createSceneManager(Ogre::ST_GENERIC, 1u, "scene-probe-mgr");

    step = 1;
    ok("Root + window + scene manager");

    // ── the mesh, by the 3a recipe ────────────────────────────────────────
    Ogre::MeshPtr mesh;
    step = 4;
    try {
        const std::vector<uint8_t> bytes = read_file(std::string(kMedia) + "/models/Barrel.mesh");
        if (bytes.empty()) throw std::runtime_error("Barrel.mesh could not be read");
        Ogre::DataStreamPtr stream(
            new Ogre::MemoryDataStream(const_cast<uint8_t *>(bytes.data()), bytes.size(), false,
                                       true));
        Ogre::v1::MeshPtr v1 = Ogre::v1::MeshManager::getSingleton().createManual("probe-v1", kGroup);
        Ogre::v1::MeshSerializer serializer;
        serializer.importMesh(stream, v1.get());
        mesh = Ogre::MeshManager::getSingleton().createByImportingV1("probe-mesh", kGroup, v1.get(),
                                                                     false, false, false);
        mesh->load();
        ok("Mesh2 '" + mesh->getName() + "' with " + std::to_string(mesh->getNumSubMeshes()) +
           " submeshes");
    } catch (const std::exception &e) {
        failed("mesh load", e.what());
        return 3;
    }

    // ── the Hlms, and whether datablocks need the templates ───────────────
    step = 2;
    Ogre::HlmsUnlit *unlit = nullptr;
    Ogre::HlmsPbs *pbs = nullptr;
    try {
        Ogre::ArchiveManager &archives = Ogre::ArchiveManager::getSingleton();
        Ogre::Archive *unlit_glsl = archives.load(std::string(kMedia) + "/Hlms/Unlit/GLSL",
                                                  "FileSystem", true);
        Ogre::Archive *pbs_glsl =
            archives.load(std::string(kMedia) + "/Hlms/Pbs/GLSL", "FileSystem", true);
        Ogre::ArchiveVec library;
        library.push_back(archives.load(std::string(kMedia) + "/Hlms/Common/GLSL", "FileSystem", true));
        library.push_back(archives.load(std::string(kMedia) + "/Hlms/Common/Any", "FileSystem", true));

        unlit = new Ogre::HlmsUnlit(unlit_glsl, &library);
        pbs = new Ogre::HlmsPbs(pbs_glsl, &library);
        root.getHlmsManager()->registerHlms(unlit);
        root.getHlmsManager()->registerHlms(pbs);
        ok("HlmsUnlit + HlmsPbs constructed from archives; registerHlms accepted both");
    } catch (const std::exception &e) {
        failed("Hlms construction", e.what());
        return 4;
    }

    step = 3;
    Ogre::HlmsUnlitDatablock *colour_db = nullptr;
    try {
        Ogre::HlmsMacroblock macroblock;
        Ogre::HlmsBlendblock blendblock;
        Ogre::HlmsParamVec params;
        colour_db = static_cast<Ogre::HlmsUnlitDatablock *>(unlit->createDatablock(
            "tension-red", "tension-red", macroblock, blendblock, params));
        colour_db->setUseColour(true);
        colour_db->setColour(Ogre::ColourValue(0.9f, 0.2f, 0.2f, 1.0f));
        ok("Unlit datablock with a colour (setUseColour + setColour)");
    } catch (const std::exception &e) {
        failed("Unlit datablock (colour)", e.what());
    }

    try {
        Ogre::TextureGpuManager *textures = rs->getTextureGpuManager();
        const std::vector<uint8_t> bytes = read_file(std::string(kMedia) + "/materials/textures/ASCII.dds");
        Ogre::DataStreamPtr stream(
            new Ogre::MemoryDataStream(const_cast<uint8_t *>(bytes.data()), bytes.size(), false, true));
        Ogre::Image2 image;
        image.load(stream);
        Ogre::TextureGpu *texture = textures->createTexture(
            "probe-dds", Ogre::GpuPageOutStrategy::Discard, Ogre::TextureFlags::ManualTexture,
            Ogre::TextureTypes::Type2D, kGroup);
        texture->setPixelFormat(image.getPixelFormat());
        texture->setTextureType(image.getTextureType());
        texture->setNumMipmaps(image.getNumMipmaps());
        texture->setResolution(image.getWidth(), image.getHeight());
        texture->scheduleTransitionTo(Ogre::GpuResidency::Resident, &image, false);

        Ogre::HlmsMacroblock macroblock;
        Ogre::HlmsBlendblock blendblock;
        Ogre::HlmsParamVec params;
        auto *texture_db = static_cast<Ogre::HlmsUnlitDatablock *>(unlit->createDatablock(
            "tension-tex", "tension-tex", macroblock, blendblock, params));
        texture_db->setTexture(0, texture->getNameStr());
        ok("Unlit datablock with a texture (setTexture(0, \"" + texture->getNameStr() + "\"))");
    } catch (const std::exception &e) {
        failed("Unlit datablock (texture)", e.what());
    }

    // ── the item and its attach call ─────────────────────────────────────
    step = 5;
    Ogre::Item *item = nullptr;
    Ogre::SceneNode *node = nullptr;
    try {
        item = scene->createItem(mesh, Ogre::SCENE_DYNAMIC);
        item->setDatablock(colour_db);
        node = scene->getRootSceneNode(Ogre::SCENE_DYNAMIC)
                   ->createChildSceneNode(Ogre::SCENE_DYNAMIC);
        node->attachObject(item); // SceneNode::attachObject — not Item::attachToNode
        node->setPosition(0.0f, 0.0f, 0.0f);
        node->setScale(0.02f, 0.02f, 0.02f); // the barrel is ~100 units wide
        ok("createItem(mesh, SCENE_DYNAMIC) + setDatablock + node->attachObject + scale");
    } catch (const std::exception &e) {
        failed("item creation/attach", e.what());
    }

    // ── the camera, and the workspace that points at it ──────────────────
    step = 6;
    Ogre::CompositorWorkspace *workspace = nullptr;
    try {
        Ogre::CompositorManager2 *compositors = root.getCompositorManager2();
        compositors->createBasicWorkspaceDef("scene-workspace", Ogre::ColourValue(0.1f, 0.1f, 0.1f, 1.0f));
        Ogre::Camera *placeholder = scene->createCamera("placeholder");
        workspace = compositors->addWorkspace(scene, window->getTexture(), placeholder,
                                              "scene-workspace", true);

        Ogre::Camera *camera = scene->createCamera("scene-camera");
        camera->setPosition(0.0f, 0.0f, 4.0f);
        camera->lookAt(0.0f, 0.0f, 0.0f);
        camera->setNearClipDistance(0.1f);
        camera->setAutoAspectRatio(true);
        compositors->removeWorkspace(workspace);
        workspace = compositors->addWorkspace(scene, window->getTexture(), camera, "scene-workspace",
                                              true);
        ok("workspace camera replaced (removeWorkspace + addWorkspace with the real camera)");
    } catch (const std::exception &e) {
        failed("camera/workspace", e.what());
    }

    // ── thirty frames ────────────────────────────────────────────────────
    step = 7;
    try {
        bool all = true;
        for (int frame = 0; frame < 30; ++frame) all = root.renderOneFrame() && all;
        ok(std::string("thirty frames with item, camera and datablock live: ") +
           (all ? "true" : "false"));
    } catch (const std::exception &e) {
        failed("frames", e.what());
        return 5;
    }

    // ── the readback ─────────────────────────────────────────────────────
    step = 8;
    if (!gl3plus) {
        ok("readback skipped under NULL: there is no framebuffer to download");
    } else {
        try {
            window->setWantsToDownload(true);
            window->setManualSwapRelease(true);
            root.renderOneFrame();
            if (!window->canDownloadData()) {
                failed("readback", "canDownloadData() stayed false");
            } else {
                Ogre::Image2 image;
                Ogre::TextureGpu *backbuffer = window->getTexture();
                image.convertFromTexture(backbuffer, 0u, backbuffer->getNumMipmaps() - 1u);
                const Ogre::TextureBox box = image.getData(0);
                const PixelStats stats = scan(box);
                std::printf("SCENE step 8: readback %ux%u %u bytes/px, %zu non-background pixels, "
                            "mean rgb %.1f/%.1f/%.1f, corner rgb %u/%u/%u\n",
                            box.width, box.height, box.bytesPerPixel, stats.non_background,
                            stats.mean_r, stats.mean_g, stats.mean_b, stats.corner_r,
                            stats.corner_g, stats.corner_b);
                if (stats.non_background == 0) failed("readback", "the image is entirely background");
            }
            window->performManualRelease();
        } catch (const std::exception &e) {
            failed("readback", e.what());
        }
    }

    step = 9;
    try {
        if (item) scene->destroyItem(item);
        scene->destroyAllCameras();
        root.shutdown();
        ok("teardown clean");
    } catch (const std::exception &e) {
        failed("teardown", e.what());
    }

    std::printf("SCENE: %s (%d failure(s))\n", failures == 0 ? "all steps ok" : "FAILURES", failures);
    return failures == 0 ? 0 : 1;
}
