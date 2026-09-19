// probe_loader.cpp — does the intended OGRE loading path work at all, under
// RenderSystem_NULL, on this install?
//
// Everything in round 3a-ii is written against this program's output, so it
// answers each question in its own step and reports rather than aborting:
// where it breaks is the finding.
//
//   1. Root + NULL render system + window + frames
//   2. a resource location for the shipped models
//   3. file IO off the render thread's plate (plain ifstream, the worker's job)
//   4. v1::MeshSerializer::importMesh from a MemoryDataStream
//   5. MeshManager::createByImportingV1 into the Mesh2 the engine wants
//   6. TextureGpuManager::createOrRetrieveTexture for a shipped texture
//   7. three frames, then a clean shutdown
//
//   g++ -std=c++17 -O1 -isystem /usr/include/OGRE-Next tests/probe_loader.cpp \
//       -o build/probe_loader -lOgreNextMain -lpthread
//   ./probe_loader /usr/lib/OGRE-Next
//
// Throwaway by intent, committed as the record of what was measured.

#include <OgreDataStream.h>
#include <OgreException.h>
#include <OgreImage2.h>
#include <OgreLogManager.h>
#include <OgreMesh.h>
#include <OgreMesh2.h>
#include <OgreMeshManager.h>
#include <OgreMeshManager2.h>
#include <OgreMeshSerializer.h>
#include <OgreRenderSystem.h>
#include <OgreResourceGroupManager.h>
#include <OgreRoot.h>
#include <OgreTextureGpu.h>
#include <OgreTextureFilters.h>
#include <OgreTextureGpuManager.h>
#include <OgreWindow.h>

#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <string>
#include <vector>

namespace {

const char *const kMedia = "/usr/share/OGRE-Next/Media";
const char *const kGroup = "Probe";

int step = 0;

void ok(const std::string &what) { std::printf("PROBE step %d: ok — %s\n", step, what.c_str()); }

void failed(const std::string &step_name, const std::string &why) {
    std::printf("PROBE step %d: FAILED (%s) — %s\n", step, step_name.c_str(), why.c_str());
}

std::vector<uint8_t> read_file(const std::string &path) {
    std::ifstream file(path, std::ios::binary);
    return std::vector<uint8_t>(std::istreambuf_iterator<char>(file),
                                std::istreambuf_iterator<char>());
}

} // namespace

int main(int argc, char **argv) {
    std::setvbuf(stdout, nullptr, _IONBF, 0); // a crash must not eat the findings
    const std::string plugin_dir = argc > 1 ? argv[1] : "/usr/lib/OGRE-Next";
    bool with_texture = !(argc > 2 && std::string(argv[2]) == "--no-texture");
    bool use_gl3plus = false;
    for (int i = 2; i < argc; ++i) {
        if (std::string(argv[i]) == "--gl3plus") { use_gl3plus = true; with_texture = true; }
    }
    {
        std::ofstream cfg("probe_loader_plugins.cfg");
        cfg << "PluginFolder=" << plugin_dir << "\n"
            << (use_gl3plus ? "Plugin=RenderSystem_GL3Plus\n" : "Plugin=RenderSystem_NULL\n");
    }
    // OGRE's chatter would drown the findings.
    Ogre::LogManager *logs = new Ogre::LogManager();
    logs->createLog("probe_loader.log", true, false);

    Ogre::Root root(nullptr, "probe_loader_plugins.cfg", "probe_loader.cfg",
                    "probe_loader.log", "probe-loader");
    const char *rs_name =
        use_gl3plus ? "OpenGL 3+ Rendering Subsystem" : "NULL Rendering Subsystem";
    Ogre::RenderSystem *rs = root.getRenderSystemByName(rs_name);
    if (!rs) {
        std::printf("PROBE: no render system named %s\n", rs_name);
        return 2;
    }
    std::printf("PROBE: render system '%s'\n", rs_name);
    root.setRenderSystem(rs);
    root.initialise(false);
    Ogre::Window *window = root.createRenderWindow("probe-loader", 320, 240, false, nullptr);

    step = 1;
    try {
        if (!root.renderOneFrame()) throw std::runtime_error("renderOneFrame said closed");
        ok("Root + NULL render system + window; one frame before any resource exists");
    } catch (const std::exception &e) {
        failed("frame loop", e.what());
        return 3;
    }

    step = 2;
    try {
        Ogre::ResourceGroupManager::getSingleton().addResourceLocation(
            std::string(kMedia) + "/models", "FileSystem", kGroup, true /* recursive */);
        Ogre::ResourceGroupManager::getSingleton().addResourceLocation(
            std::string(kMedia) + "/materials/textures", "FileSystem", kGroup,
            true /* recursive */);
        Ogre::ResourceGroupManager::getSingleton().initialiseResourceGroup(kGroup,
                                                                           true /* changeLocale */);
        const bool known = Ogre::ResourceGroupManager::getSingleton().resourceExists(
            kGroup, "Barrel.mesh");
        ok("resource location added; Barrel.mesh "
           + std::string(known ? "found" : "NOT found by the group manager"));
    } catch (const std::exception &e) {
        failed("resource location", e.what());
        return 4;
    }

    step = 3;
    const std::vector<uint8_t> mesh_bytes = read_file(std::string(kMedia) + "/models/Barrel.mesh");
    if (mesh_bytes.size() < 16) {
        failed("file IO", "Barrel.mesh could not be read");
        return 5;
    }
    ok("read " + std::to_string(mesh_bytes.size()) + " bytes of Barrel.mesh outside OGRE; magic is '" +
       std::string(reinterpret_cast<const char *>(mesh_bytes.data()), 15) + "'");

    Ogre::v1::MeshPtr v1_mesh;
    step = 4;
    try {
        Ogre::DataStreamPtr stream(new Ogre::MemoryDataStream(
            const_cast<uint8_t *>(mesh_bytes.data()), mesh_bytes.size(), false, true));
        v1_mesh = Ogre::v1::MeshManager::getSingleton().createManual("probe-v1", kGroup);
        Ogre::v1::MeshSerializer serializer;
        serializer.importMesh(stream, v1_mesh.get());
        ok("importMesh from a MemoryDataStream: v1 mesh '" + v1_mesh->getName() + "' with " +
           std::to_string(v1_mesh->getNumSubMeshes()) + " submeshes");
    } catch (const std::exception &e) {
        failed("importMesh", e.what());
        return 6;
    }

    step = 5;
    Ogre::MeshPtr mesh;
    try {
        mesh = Ogre::MeshManager::getSingleton().createByImportingV1(
            "probe-mesh2", kGroup, v1_mesh.get(), false, false, false);
        const unsigned before = mesh->getNumSubMeshes();
        mesh->load(); // the v1 -> v2 conversion happens here, not at creation
        ok("createByImportingV1: Mesh2 '" + mesh->getName() + "' submeshes " +
           std::to_string(before) + " -> " + std::to_string(mesh->getNumSubMeshes()) +
           " after load() (NULL RS VaoManager usable)");
    } catch (const std::exception &e) {
        failed("createByImportingV1", e.what());
        return 7;
    }

    // Textures are driven asynchronously, which is also how the adapter will
    // drive them: schedule the transition, let frames run, then look. Blocking
    // on waitForData() aborted the process on this install (measured: it lands
    // in TextureGpuManager::_update and dies destroying an exception).
    step = 6;
    Ogre::TextureGpu *texture = nullptr;
    Ogre::Image2 image;
    if (!with_texture) {
        ok("texture steps skipped (--no-texture): the mesh path is measured on its own");
    } else
    try {
        Ogre::TextureGpuManager *textures = rs->getTextureGpuManager();
        // The memory route, which is what the adapter needs: the loader reads
        // bytes, so the render thread must be able to turn bytes into a
        // texture without a file on disk.
        const std::vector<uint8_t> tex_bytes =
            read_file(std::string(kMedia) + "/materials/textures/ASCII.dds");
        if (tex_bytes.empty()) throw std::runtime_error("ASCII.dds could not be read");
        Ogre::DataStreamPtr stream(
            new Ogre::MemoryDataStream(const_cast<uint8_t *>(tex_bytes.data()), tex_bytes.size(),
                                       false, true));
        image.load(stream, "dds");
        texture = textures->createTexture("probe-tex", Ogre::GpuPageOutStrategy::Discard,
                                          Ogre::TextureFlags::ManualTexture,
                                          Ogre::TextureTypes::Type2D,
                                          Ogre::ResourceGroupManager::DEFAULT_RESOURCE_GROUP_NAME);
        // The "manually fill" settings, taken from the image we are about to
        // hand it: format, type, mip count and resolution are the texture's
        // own until the schedule carries the data in.
        texture->setPixelFormat(image.getPixelFormat());
        texture->setTextureType(image.getTextureType());
        texture->setNumMipmaps(image.getNumMipmaps());
        texture->setResolution(image.getWidth(), image.getHeight());
        ok("Image2 from memory: " + std::to_string(image.getWidth()) + "x" +
           std::to_string(image.getHeight()));
        ok("createOrRetrieveTexture returned '" + texture->getNameStr() + "' (not scheduled yet)");
    } catch (const std::exception &e) {
        failed("createOrRetrieveTexture", e.what());
        return 8;
    }

    step = 7;
    if (with_texture)
    try {
        texture->scheduleTransitionTo(Ogre::GpuResidency::Resident, &image, false);
        texture->waitForMetadata();
        for (int frame = 0; frame < 6; ++frame) root.renderOneFrame();
        const std::string verdict = (texture->getWidth() > 2 && texture->getHeight() > 2)
                                        ? "real image"
                                        : "PLACEHOLDER";
        ok("texture '" + texture->getNameStr() + "' " + std::to_string(texture->getWidth()) + "x" +
           std::to_string(texture->getHeight()) + " dataReady=" +
           std::to_string(static_cast<int>(texture->isDataReady())) + " — " + verdict);
    } catch (const std::exception &e) {
        failed("texture from memory", e.what());
        return 8;
    }

    step = 8;
    try {
        bool all = true;
        for (int frame = 0; frame < 3; ++frame) all = root.renderOneFrame() && all;
        ok(std::string("three frames with a mesh and a texture resident: ") + (all ? "true" : "false"));
    } catch (const std::exception &e) {
        failed("frames with resources", e.what());
        return 9;
    }

    step = 9;
    try {
        if (texture != nullptr) rs->getTextureGpuManager()->destroyTexture(texture);
        mesh->unload();
        v1_mesh->unload();
        if (window) rs->destroyRenderWindow(window);
        root.shutdown();
        ok("destroyTexture, mesh unload, window destroy, Root::shutdown — clean");
    } catch (const std::exception &e) {
        failed("teardown", e.what());
        return 10;
    }

    std::printf("PROBE: all steps ok\n");
    return 0;
}
