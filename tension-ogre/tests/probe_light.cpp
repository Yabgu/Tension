// probe_light.cpp — nine measurements before anything is written against them
// (chunk 10, round 10a).
//
// The light path is implemented end to end and has never been exercised: the
// wire's LightRecord is complete, the adapter decodes it on the generic submit
// verb, apply_submissions calls apply_lights in the right place, and
// apply_lights creates the Ogre light, attaches it to a dynamic node and sets
// its direction — in the order `createLight()`'s own documentation demands. No
// fixture has ever called `submitLight`, and every PBS material in the repo has
// a zero diffuse, so nothing has ever been lit.
//
// This probe is the prove-or-refute instrument. It answers:
//
//   1. the call sequence, and whether attachObject-before-setDirection is real
//   2. whether a light needs a node
//   3. dynamic node vs static node for a light
//   4. **the crux**: does a PBS datablock with diffuse+specular, emissive zero,
//      shade at all under one directional light
//   5. the hemisphere profile — the numbers the acid test's thresholds come from
//   6. Forward+ configuration, the second call, and the frame cost of lights
//   7. the no-light fallback: an emissive-only PBS material and an Unlit
//      material must be byte-identical with and without a light in the scene
//   8. the skinned path shades (Stickman under a lit PBS datablock)
//   9. the PBS archive folder list against `HlmsPbs::getDefaultPaths()`
//
//   g++ -std=c++17 -O1 -isystem /usr/include/OGRE-Next \
//       -isystem /usr/include/OGRE-Next/Hlms/Common \
//       -isystem /usr/include/OGRE-Next/Hlms/Unlit \
//       -isystem /usr/include/OGRE-Next/Hlms/Pbs \
//       tests/probe_light.cpp -o build/probe-light/probe_light \
//       -lOgreNextMain -lOgreNextHlmsUnlit -lOgreNextHlmsPbs -lpthread
//   ./probe_light /usr/lib/OGRE-Next [--lights=N] [--lights-per-cell=N]
//                [--order=direction-first] [--node=none|static]
//                [--point-far] [--time=N] [--skinned] [--forward-twice]
//
// The background is the workspace's own grey (0.35): a black background and an
// unlit hemisphere are the same pixels, and this probe's whole subject is the
// difference between dark and not drawn.

#include <OgreArchiveManager.h>
#include <OgreCamera.h>
#include <OgreColourValue.h>
#include <Compositor/OgreCompositorManager2.h>
#include <Compositor/OgreCompositorWorkspace.h>
#include <OgreDataStream.h>
#include <OgreException.h>
#include <OgreFrameListener.h>
#include <OgreHlmsManager.h>
#include <OgreImage2.h>
#include <OgreItem.h>
#include <OgreLight.h>
#include <OgreLogManager.h>
#include <OgreAxisAlignedBox.h>
#include <OgreHardwareBufferManager.h>
#include <OgreHardwareIndexBuffer.h>
#include <OgreHardwareVertexBuffer.h>
#include <OgreMesh.h>
#include <OgreMeshManager.h>
#include <OgreSubMesh.h>
#include <OgreVertexIndexData.h>
#include <OgreMeshManager2.h>
#include <OgreMesh2.h>
#include <OgreTextureBox.h>
#include <OgreResourceGroupManager.h>
#include <OgreRoot.h>
#include <OgreSceneManager.h>
#include <OgreSceneNode.h>
#include <OgreTextureGpu.h>
#include <OgreWindow.h>
#include <Hlms/Pbs/OgreHlmsPbs.h>
#include <Hlms/Pbs/OgreHlmsPbsDatablock.h>
#include <Hlms/Unlit/OgreHlmsUnlit.h>
#include <Hlms/Unlit/OgreHlmsUnlitDatablock.h>
#include <OgreMeshSerializer.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <string>
#include <vector>

namespace {

const char *const kMedia = "/usr/share/OGRE-Next/Media";
const char *const kGroup = "General";
const uint32_t kWindowWidth = 320;
const uint32_t kWindowHeight = 240;
/** Where the three spheres sit, and where they land on the screen: the camera
 * is (0,0,6) at a 45° vertical FOV, so one world unit at that depth is
 * 120 / (6·tan(22.5°)) ≈ 48.3 px. */
const float kSphereX[3] = {-2.4f, 0.0f, 2.4f};
const int kSphereCx[3] = {44, 160, 276};
const int kSphereRadiusPx = 48;

double now_us() {
    using clock = std::chrono::steady_clock;
    return std::chrono::duration<double, std::micro>(clock::now().time_since_epoch()).count();
}

std::vector<uint8_t> read_file(const std::string &path) {
    std::ifstream file(path, std::ios::binary);
    return std::vector<uint8_t>(std::istreambuf_iterator<char>(file),
                                std::istreambuf_iterator<char>());
}

bool path_exists(const std::string &path) {
    std::ifstream file(path);
    return file.good();
}

// ── the readback (the frame-listener path probe_motion/probe_skinning use) ──

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
        out = frame;
        return true;
    }
    return false;
}

/// A pixel's brightness, 0..255: the mean of the three channels. The probe's
/// subject is a shading gradient, and the mean is what a viewer sees.
int brightness(const Frame &frame, size_t x, size_t y) {
    const uint8_t *p = frame.pixels.data() + (y * frame.width + x) * frame.bpp;
    return (static_cast<int>(p[0]) + static_cast<int>(p[1]) + static_cast<int>(p[2])) / 3;
}

bool is_background(const Frame &frame, size_t x, size_t y) {
    // The workspace colour (0.35 grey), not "darker than 40": a black unlit
    // hemisphere is exactly what this probe must be able to see.
    const uint8_t *p = frame.pixels.data() + (y * frame.width + x) * frame.bpp;
    return std::abs(static_cast<int>(p[0]) - 89) <= 10 &&
           std::abs(static_cast<int>(p[1]) - 89) <= 10 &&
           std::abs(static_cast<int>(p[2]) - 89) <= 10;
}

struct RegionStats {
    size_t count = 0;
    double mean = 0.0;
    int max_channel = 0;
    int min_channel = 255;
};

RegionStats region(const Frame &frame, int cx, int half_width) {
    RegionStats stats;
    double sum = 0.0;
    for (int y = 0; y < static_cast<int>(frame.height); ++y) {
        for (int x = std::max(0, cx - half_width);
             x < std::min(static_cast<int>(frame.width), cx + half_width); ++x) {
            if (is_background(frame, static_cast<size_t>(x), static_cast<size_t>(y))) continue;
            const int b = brightness(frame, static_cast<size_t>(x), static_cast<size_t>(y));
            sum += b;
            stats.count += 1;
            stats.max_channel = std::max(stats.max_channel, b);
            stats.min_channel = std::min(stats.min_channel, b);
        }
    }
    stats.mean = stats.count ? sum / static_cast<double>(stats.count) : 0.0;
    return stats;
}

/// The sphere's own pixels, split by the light's projection axis. The light
/// travels along -x and the camera looks down -z, so the lit hemisphere is the
/// screen-right half: the split is at the sphere's projected centre column.
struct Halves {
    size_t lit_count = 0, dark_count = 0;
    double lit_mean = 0.0, dark_mean = 0.0, mid_mean = 0.0;
    double profile[10] = {};
    int profile_count[10] = {};
};

Halves halves(const Frame &frame, int cx) {
    Halves h;
    double lit_sum = 0.0, dark_sum = 0.0, mid_sum = 0.0;
    int mid_n = 0;
    for (int y = 0; y < static_cast<int>(frame.height); ++y) {
        for (int x = cx - kSphereRadiusPx; x <= cx + kSphereRadiusPx; ++x) {
            if (x < 0 || x >= static_cast<int>(frame.width)) continue;
            if (is_background(frame, static_cast<size_t>(x), static_cast<size_t>(y))) continue;
            const int b = brightness(frame, static_cast<size_t>(x), static_cast<size_t>(y));
            const int band = std::min(9, std::max(0, (x - (cx - kSphereRadiusPx)) * 10 /
                                                         (2 * kSphereRadiusPx)));
            h.profile[band] += b;
            h.profile_count[band] += 1;
            if (x > cx) {
                ++h.lit_count;
                lit_sum += b;
            } else {
                ++h.dark_count;
                dark_sum += b;
            }
            if (std::abs(x - cx) <= 4) {
                ++mid_n;
                mid_sum += b;
            }
        }
    }
    h.lit_mean = h.lit_count ? lit_sum / static_cast<double>(h.lit_count) : 0.0;
    h.dark_mean = h.dark_count ? dark_sum / static_cast<double>(h.dark_count) : 0.0;
    h.mid_mean = mid_n ? mid_sum / static_cast<double>(mid_n) : 0.0;
    return h;
}

/// Whether two frames differ in a region, byte for byte (alpha ignored).
bool region_identical(const Frame &a, const Frame &b, int cx, int half_width) {
    if (a.width != b.width || a.height != b.height || a.pixels.empty() || b.pixels.empty()) {
        return false;
    }
    for (int y = 0; y < static_cast<int>(a.height); ++y) {
        for (int x = std::max(0, cx - half_width);
             x < std::min(static_cast<int>(a.width), cx + half_width); ++x) {
            for (int c = 0; c < 3; ++c) {
                const size_t at = (static_cast<size_t>(y) * a.width + x) * a.bpp + c;
                if (a.pixels[at] != b.pixels[at]) return false;
            }
        }
    }
    return true;
}

struct Loaded {
    Ogre::MeshPtr mesh;
    bool rigged = false;
    float radius = 0.0f; // the source mesh's bounding radius, from the v1 side
};

Loaded load_mesh(const Ogre::String &file) {
    Loaded loaded;
    const std::vector<uint8_t> bytes = read_file(std::string(kMedia) + "/models/" + file.c_str());
    if (bytes.empty()) return loaded;
    Ogre::DataStreamPtr stream(new Ogre::MemoryDataStream(
        const_cast<uint8_t *>(bytes.data()), bytes.size(), false, true));
    Ogre::v1::MeshPtr v1 = Ogre::v1::MeshManager::getSingleton().createManual(file + "-v1", kGroup);
    Ogre::v1::MeshSerializer serializer;
    serializer.importMesh(stream, v1.get());
    loaded.mesh = Ogre::MeshManager::getSingleton().createByImportingV1(
        file, kGroup, v1.get(), false, false, false);
    loaded.radius = (v1->getBounds().getSize() * 0.5f).length();
    loaded.mesh->load();
    loaded.rigged = loaded.mesh->hasSkeleton();
    return loaded;
}

/// A UV sphere, built by hand: the probe's shading measurement should not
/// depend on a media file, and the one it was pointed at first (`Smiley.mesh`)
/// turned out to be *rigged* — it ships with a Smiley.skeleton — so importing
/// it without a reachable skeleton left the PBS vertex path reading bone
/// matrices that were never filled: a SIGSEGV inside HlmsPbs::fillBuffersForV2
/// with no exception and no log line. Radius 1, normals = position, UVs from the
/// spherical angles.
Ogre::MeshPtr make_uv_sphere(const Ogre::String &name, float radius, int slices, int stacks) {
    const int vertex_count = (stacks + 1) * (slices + 1);
    const int index_count = stacks * slices * 6;
    std::vector<float> vertices;
    vertices.reserve(static_cast<size_t>(vertex_count) * 8);
    for (int i = 0; i <= stacks; ++i) {
        const float v = static_cast<float>(i) / static_cast<float>(stacks);
        const float phi = v * 3.14159265358979f;
        for (int j = 0; j <= slices; ++j) {
            const float u = static_cast<float>(j) / static_cast<float>(slices);
            const float theta = u * 2.0f * 3.14159265358979f;
            const float x = std::sin(phi) * std::cos(theta);
            const float y = std::cos(phi);
            const float z = std::sin(phi) * std::sin(theta);
            vertices.push_back(radius * x);
            vertices.push_back(radius * y);
            vertices.push_back(radius * z);
            vertices.push_back(x);
            vertices.push_back(y);
            vertices.push_back(z);
            vertices.push_back(u);
            vertices.push_back(v);
        }
    }
    std::vector<uint16_t> indices;
    indices.reserve(static_cast<size_t>(index_count));
    for (int i = 0; i < stacks; ++i) {
        for (int j = 0; j < slices; ++j) {
            const uint16_t a = static_cast<uint16_t>(i * (slices + 1) + j);
            const uint16_t b = static_cast<uint16_t>(a + slices + 1);
            indices.push_back(a); indices.push_back(b); indices.push_back(a + 1);
            indices.push_back(a + 1); indices.push_back(b); indices.push_back(b + 1);
        }
    }
    Ogre::v1::MeshPtr v1 = Ogre::v1::MeshManager::getSingleton().createManual(name + "-v1", kGroup);
    Ogre::v1::SubMesh *sub = v1->createSubMesh();
    sub->useSharedVertices = false;
    sub->operationType = Ogre::OT_TRIANGLE_LIST;
    sub->vertexData[Ogre::VpNormal] = OGRE_NEW Ogre::v1::VertexData(
        Ogre::v1::HardwareBufferManager::getSingletonPtr());
    Ogre::v1::VertexData *vertex_data = sub->vertexData[Ogre::VpNormal];
    vertex_data->vertexStart = 0;
    vertex_data->vertexCount = vertex_count;
    const size_t f3 = Ogre::v1::VertexElement::getTypeSize(Ogre::VET_FLOAT3);
    const size_t f2 = Ogre::v1::VertexElement::getTypeSize(Ogre::VET_FLOAT2);
    Ogre::v1::VertexDeclaration *declaration = vertex_data->vertexDeclaration;
    size_t offset = 0;
    declaration->addElement(0, offset, Ogre::VET_FLOAT3, Ogre::VES_POSITION);
    offset += f3;
    declaration->addElement(0, offset, Ogre::VET_FLOAT3, Ogre::VES_NORMAL);
    offset += f3;
    declaration->addElement(0, offset, Ogre::VET_FLOAT2, Ogre::VES_TEXTURE_COORDINATES, 0);
    offset += f2;
    const size_t stride = offset;
    Ogre::v1::HardwareVertexBufferSharedPtr vertex_buffer =
        Ogre::v1::HardwareBufferManager::getSingleton().createVertexBuffer(
            stride, vertex_count, Ogre::v1::HardwareBuffer::HBU_STATIC_WRITE_ONLY, false);
    vertex_data->vertexBufferBinding->setBinding(0, vertex_buffer);
    {
        void *destination = vertex_buffer->lock(Ogre::v1::HardwareBuffer::HBL_DISCARD);
        std::memcpy(destination, vertices.data(), vertices.size() * sizeof(float));
        vertex_buffer->unlock();
    }
    sub->indexData[Ogre::VpNormal] = OGRE_NEW Ogre::v1::IndexData();
    Ogre::v1::IndexData *index_data = sub->indexData[Ogre::VpNormal];
    index_data->indexStart = 0;
    index_data->indexCount = index_count;
    Ogre::v1::HardwareIndexBufferSharedPtr index_buffer =
        Ogre::v1::HardwareBufferManager::getSingleton().createIndexBuffer(
            Ogre::v1::HardwareIndexBuffer::IT_16BIT, index_count,
            Ogre::v1::HardwareBuffer::HBU_STATIC_WRITE_ONLY, false);
    {
        void *destination = index_buffer->lock(Ogre::v1::HardwareBuffer::HBL_DISCARD);
        std::memcpy(destination, indices.data(), indices.size() * sizeof(uint16_t));
        index_buffer->unlock();
    }
    index_data->indexBuffer = index_buffer;
    v1->_setBounds(Ogre::AxisAlignedBox(-radius, -radius, -radius, radius, radius, radius));
    Ogre::MeshPtr mesh = Ogre::MeshManager::getSingleton().createByImportingV1(name, kGroup, v1.get(),
                                                                              false, false, false);
    // The load is not optional: `createItem` resolves the mesh through the
    // resource manager by name, and an unloaded Mesh2 sends `Ogre::Mesh::importV1`
    // back to a v1 resource that a hand-built mesh is not — a SIGSEGV in
    // `v1::Mesh::calculateSize`, again with no exception and no log line. The
    // adapter's own mesh path calls this for the same reason.
    mesh->load();
    return mesh;
}

Ogre::HlmsDatablock *make_pbs(Ogre::HlmsPbs *pbs, const Ogre::String &name,
                              const Ogre::Vector3 &diffuse, const Ogre::Vector3 &specular,
                              const Ogre::Vector3 &emissive, float roughness, float metalness) {
    Ogre::HlmsMacroblock macroblock;
    Ogre::HlmsBlendblock blendblock;
    Ogre::HlmsParamVec params;
    auto *datablock = static_cast<Ogre::HlmsPbsDatablock *>(
        pbs->createDatablock(name, name, macroblock, blendblock, params));
    datablock->setDiffuse(diffuse);
    datablock->setSpecular(specular);
    datablock->setEmissive(emissive);
    datablock->setRoughness(roughness);
    datablock->setMetalness(metalness);
    return datablock;
}

} // namespace

int main(int argc, char **argv) {
    std::setvbuf(stdout, nullptr, _IONBF, 0);
    if (argc < 2) {
        std::fprintf(stderr, "usage: probe_light <plugin-dir> [--flags]\n");
        return 2;
    }
    const std::string plugin_dir = argv[1];
    int light_count = 1;
    int lights_per_cell = 96;
    bool direction_first = false;
    std::string node_mode = "dynamic";
    bool point_far = false;
    int timed_frames = 0;
    bool skinned = false;
    bool forward_twice = false;
    float power = 1.0f;
    for (int i = 2; i < argc; ++i) {
        const std::string arg = argv[i];
        if (arg.rfind("--lights=", 0) == 0) light_count = std::stoi(arg.substr(9));
        if (arg.rfind("--lights-per-cell=", 0) == 0) lights_per_cell = std::stoi(arg.substr(18));
        if (arg == "--order=direction-first") direction_first = true;
        if (arg.rfind("--node=", 0) == 0) node_mode = arg.substr(7);
        if (arg == "--point-far") point_far = true;
        if (arg.rfind("--time=", 0) == 0) timed_frames = std::stoi(arg.substr(7));
        if (arg == "--skinned") skinned = true;
        if (arg == "--forward-twice") forward_twice = true;
        if (arg.rfind("--power=", 0) == 0) power = std::stof(arg.substr(8));
    }

    {
        std::ofstream cfg("light_plugins.cfg");
        cfg << "PluginFolder=" << plugin_dir << "\n"
            << "Plugin=RenderSystem_GL3Plus\n";
    }
    Ogre::LogManager *logs = new Ogre::LogManager();
    logs->createLog("light_probe.log", true, false);
    Ogre::Root root(nullptr, "light_plugins.cfg", "light_probe.cfg", "light_probe.log", "light");
    Ogre::RenderSystem *rs = root.getRenderSystemByName("OpenGL 3+ Rendering Subsystem");
    if (rs == nullptr) {
        std::printf("LIGHT: the GL3+ render system is not in this install\n");
        return 2;
    }
    root.setRenderSystem(rs);
    root.initialise(false);

    Ogre::NameValuePairList params;
    params["width"] = std::to_string(kWindowWidth);
    params["height"] = std::to_string(kWindowHeight);
    Ogre::Window *window =
        root.createRenderWindow("light-probe", kWindowWidth, kWindowHeight, false, &params);
    Ogre::SceneManager *scene = root.createSceneManager(Ogre::ST_GENERIC, 1u, "light-mgr");

    // ── Q9 first: the archive folder list, before any black is believed ──
    std::printf("Q9 the PBS archive list, from HlmsPbs::getDefaultPaths():\n");
    Ogre::ArchiveVec pbs_library;
    Ogre::StringVector pbs_paths;
    std::string pbs_main;
    {
        Ogre::String main_path;
        Ogre::HlmsPbs::getDefaultPaths(main_path, pbs_paths);
        pbs_main = std::string(main_path.c_str());
        std::printf("Q9 data folder: %s (%s)\n", pbs_main.c_str(),
                    path_exists(std::string(kMedia) + "/" + pbs_main) ? "present" : "MISSING");
        for (const Ogre::String &path : pbs_paths) {
            const std::string full = std::string(kMedia) + "/" + path.c_str();
            std::printf("Q9 library folder: %s (%s)\n", full.c_str(),
                        path_exists(full) ? "present" : "MISSING");
        }
    }
    auto &archives = Ogre::ArchiveManager::getSingleton();
    {
        Ogre::Archive *data = archives.load(std::string(kMedia) + "/" + pbs_main, "FileSystem", true);
        Ogre::ArchiveVec library;
        for (const Ogre::String &path : pbs_paths) {
            library.push_back(archives.load(std::string(kMedia) + "/" + path.c_str(),
                                            "FileSystem", true));
        }
        root.getHlmsManager()->registerHlms(new Ogre::HlmsPbs(data, &library));
        // Unlit comes from its own default paths, for the same reason PBS does.
        Ogre::String unlit_main;
        Ogre::StringVector unlit_paths;
        Ogre::HlmsUnlit::getDefaultPaths(unlit_main, unlit_paths);
        Ogre::Archive *unlit_data = archives.load(std::string(kMedia) + "/" + unlit_main, "FileSystem", true);
        Ogre::ArchiveVec unlit_library;
        for (const Ogre::String &path : unlit_paths) {
            unlit_library.push_back(archives.load(std::string(kMedia) + "/" + path.c_str(),
                                                  "FileSystem", true));
        }
        root.getHlmsManager()->registerHlms(new Ogre::HlmsUnlit(unlit_data, &unlit_library));
    }
    (void)pbs_library;

    scene->setForwardClustered(true, 16u, 8u, 24u, static_cast<Ogre::uint32>(lights_per_cell),
                               2u, 0u, 0.0f, 100000.0f);
    std::printf("Q6 forward-clustered: 16x8x24 froxels, lightsPerCell=%d, near 0, far 100000\n",
                lights_per_cell);
    if (forward_twice) {
        scene->setForwardClustered(true, 16u, 8u, 24u, static_cast<Ogre::uint32>(lights_per_cell),
                                   2u, 0u, 0.0f, 100000.0f);
        std::printf("Q6 setForwardClustered called a second time: no exception, no log line\n");
    }

    Ogre::Camera *camera = scene->createCamera("light-camera");
    camera->setPosition(0.0f, 0.0f, 6.0f);
    camera->lookAt(0.0f, 0.0f, 0.0f);
    camera->setNearClipDistance(0.1f);
    camera->setAutoAspectRatio(true);
    Ogre::CompositorManager2 *compositors = root.getCompositorManager2();
    compositors->createBasicWorkspaceDef("light-workspace",
                                         Ogre::ColourValue(0.35f, 0.35f, 0.35f, 1.0f));
    if (compositors->addWorkspace(scene, window->getTexture(), camera, "light-workspace", true) ==
        nullptr) {
        std::printf("LIGHT: the workspace was refused\n");
        return 2;
    }
    Downloader downloader;
    downloader.window = window;
    root.addFrameListener(&downloader);

    auto *pbs = static_cast<Ogre::HlmsPbs *>(root.getHlmsManager()->getHlms(Ogre::HLMS_PBS));
    auto *unlit = static_cast<Ogre::HlmsUnlit *>(root.getHlmsManager()->getHlms(Ogre::HLMS_UNLIT));

    // ── Q8 (its own arm): the skinned path under a lit PBS datablock ─────
    if (skinned) {
        // The location is what lets the conversion find Stickman.skeleton beside
        // the mesh; without it the rig is a name with no bones (5b's finding).
        Ogre::ResourceGroupManager::getSingleton().addResourceLocation(
            std::string(kMedia) + "/models", "FileSystem", kGroup, false);
        const Loaded stickman = load_mesh("Stickman.mesh");
        std::printf("Q8 Stickman.mesh loaded, rigged=%s\n", stickman.rigged ? "yes" : "no");
        if (!stickman.mesh) return 2;
        Ogre::HlmsDatablock *lit = make_pbs(pbs, "stickman-lit",
                                            Ogre::Vector3(0.8f, 0.5f, 0.3f),
                                            Ogre::Vector3(0.5f, 0.5f, 0.5f),
                                            Ogre::Vector3(0.0f, 0.0f, 0.0f), 0.5f, 0.0f);
        // Two frames before the item: a datablock carries DirtyTextures until a
        // frame uploads it, and an item bound before that gets a deferred hash
        // (probe_skinning's finding).
        for (int i = 0; i < 2; ++i) root.renderOneFrame();
        Ogre::Item *item = scene->createItem(stickman.mesh, Ogre::SCENE_DYNAMIC);
        item->setDatablock(lit);
        Ogre::SceneNode *node =
            scene->getRootSceneNode(Ogre::SCENE_DYNAMIC)->createChildSceneNode(Ogre::SCENE_DYNAMIC);
        node->setScale(0.6f, 0.6f, 0.6f); // 5b's fixture scale: the stickman is ~3 units tall
        node->attachObject(item);
        Ogre::Light *light = scene->createLight();
        light->setType(Ogre::Light::LT_DIRECTIONAL);
        light->setDiffuseColour(Ogre::ColourValue(1.0f, 1.0f, 1.0f));
        light->setSpecularColour(Ogre::ColourValue(1.0f, 1.0f, 1.0f));
        Ogre::SceneNode *light_node =
            scene->getRootSceneNode(Ogre::SCENE_DYNAMIC)->createChildSceneNode(Ogre::SCENE_DYNAMIC);
        light_node->attachObject(light);
        light->setDirection(Ogre::Vector3(-1.0f, 0.0f, 0.0f));
        for (int i = 0; i < 4; ++i) root.renderOneFrame();
        Frame frame;
        if (grab(&root, downloader, frame)) {
            const Halves h = halves(frame, static_cast<int>(frame.width) / 2);
            std::printf("Q8 Stickman lit halves: left(mean %.2f over %zu px) right(mean %.2f over "
                        "%zu px), ratio %.3f, mid %.2f\n",
                        h.dark_mean, h.dark_count, h.lit_mean, h.lit_count,
                        h.lit_mean > 0.0 ? h.lit_mean / std::max(0.01, h.dark_mean) : 0.0,
                        h.mid_mean);
        }
        return 0;
    }

    // The mesh the probe measures with. Not Smiley.mesh — that one ships with a
    // skeleton, and a hand-built or skeleton-less import of it crashes the PBS
    // vertex path (`fillBuffersForV2` reads bone matrices nobody filled) — and
    // not a procedural mesh either: a Mesh2 built by hand has no file, so
    // `Mesh2::load()` sends the importer back to the resource manager for a
    // v1 mesh that is not on disk, and `v1::Mesh::calculateSize` dereferences
    // null. Both of those were measured, in this probe, as SIGSEGVs with no
    // exception and no log line. Barrel.mesh is file-backed, unrigged, and
    // curved, which is all the hemisphere analysis needs; it is scaled so its
    // bounding radius is 1, the number the projection arithmetic assumes.
    const Loaded barrel = load_mesh("Barrel.mesh");
    if (!barrel.mesh) {
        std::printf("Q4 Barrel.mesh could not be loaded\n");
        return 2;
    }
    const float barrel_radius = barrel.radius;
    const float barrel_scale = barrel_radius > 0.0001f ? 1.0f / barrel_radius : 1.0f;
    std::printf("Q4 mesh: Barrel.mesh, bounding radius %.4f, scaled by %.4f to radius 1, "
                "rigged=%s\n",
                barrel_radius, barrel_scale, barrel.rigged ? "yes" : "no");
    const Ogre::MeshPtr sphere_mesh = barrel.mesh;
    Ogre::HlmsDatablock *lit_datablock =
        make_pbs(pbs, "probe-lit", Ogre::Vector3(0.8f, 0.2f, 0.2f),
                 Ogre::Vector3(0.5f, 0.5f, 0.5f), Ogre::Vector3(0.0f, 0.0f, 0.0f), 0.5f, 0.0f);
    Ogre::HlmsDatablock *emissive_datablock =
        make_pbs(pbs, "probe-emissive", Ogre::Vector3(0.0f, 0.0f, 0.0f),
                 Ogre::Vector3(0.0f, 0.0f, 0.0f), Ogre::Vector3(0.9f, 0.55f, 0.25f), 1.0f, 0.0f);
    Ogre::HlmsMacroblock macroblock;
    Ogre::HlmsBlendblock blendblock;
    Ogre::HlmsParamVec param_vec;
    auto *unlit_datablock = static_cast<Ogre::HlmsUnlitDatablock *>(
        unlit->createDatablock("probe-unlit", "probe-unlit", macroblock, blendblock, param_vec));
    unlit_datablock->setUseColour(true);
    unlit_datablock->setColour(Ogre::ColourValue(0.9f, 0.55f, 0.25f, 1.0f));

    std::printf("Q4 materials: lit diffuse=(0.8,0.2,0.2) specular=(0.5,0.5,0.5) emissive=(0,0,0) "
                "roughness=0.5 metalness=0.0 | emissive-only diffuse=(0,0,0) emissive=(0.9,0.55,0.25) "
                "| unlit colour=(0.9,0.55,0.25)\n");
    for (int i = 0; i < 2; ++i) root.renderOneFrame();
    Ogre::Item *items[3];
    for (int i = 0; i < 3; ++i) {
        items[i] = scene->createItem(sphere_mesh, Ogre::SCENE_DYNAMIC);
        items[i]->setDatablock(i == 0 ? lit_datablock : (i == 1 ? emissive_datablock
                                                               : unlit_datablock));
        Ogre::SceneNode *node =
            scene->getRootSceneNode(Ogre::SCENE_DYNAMIC)->createChildSceneNode(Ogre::SCENE_DYNAMIC);
        node->setPosition(kSphereX[i], 0.0f, 0.0f);
        node->setScale(barrel_scale, barrel_scale, barrel_scale);
        node->attachObject(items[i]);
    }

    // ── the lights ───────────────────────────────────────────────────────
    std::vector<Ogre::Light *> lights;
    std::vector<Ogre::SceneNode *> light_nodes;
    for (int i = 0; i < light_count + (point_far ? 1 : 0); ++i) {
        Ogre::Light *light = scene->createLight();
        const bool far_point = point_far && i == light_count;
        if (far_point) {
            light->setType(Ogre::Light::LT_POINT);
            light->setDiffuseColour(Ogre::ColourValue(1.0f, 1.0f, 1.0f));
            light->setSpecularColour(Ogre::ColourValue(0.0f, 0.0f, 0.0f));
        } else {
            light->setType(Ogre::Light::LT_DIRECTIONAL);
            light->setDiffuseColour(Ogre::ColourValue(1.0f, 1.0f, 1.0f));
            light->setSpecularColour(Ogre::ColourValue(1.0f, 1.0f, 1.0f));
            light->setPowerScale(power);
        }
        // A light casts shadows by default, and the basic workspace has no
        // shadow node — which is where the first run of this probe crashed
        // with no exception and no log line. The adapter's apply_lights does
        // not set this either.
        light->setCastShadows(false);
        if (node_mode != "none") {
            const Ogre::SceneMemoryMgrTypes type =
                node_mode == "static" ? Ogre::SCENE_STATIC : Ogre::SCENE_DYNAMIC;
            Ogre::SceneNode *node = scene->getRootSceneNode(type)->createChildSceneNode(type);
            node->setPosition(far_point ? 0.0f : 4.0f, far_point ? 200000.0f : 4.0f, 6.0f + static_cast<float>(i));
            node->attachObject(light);
            light_nodes.push_back(node);
            if (direction_first) {
                light->setDirection(Ogre::Vector3(-1.0f, 0.0f, 0.0f));
            }
        }
        if (!far_point && direction_first) {
            std::printf("Q1 light %d: setDirection called *before* attachObject\n", i);
        } else if (!far_point) {
            light->setDirection(Ogre::Vector3(-1.0f, 0.0f, 0.0f));
            std::printf("Q1 light %d: attachObject then setDirection (the header's order)\n", i);
        } else {
            std::printf("Q6 a point light at y=4 with a 100000 far plane: it is inside the "
                        "froxel volume; --point-far moves it out\n");
        }
        lights.push_back(light);
    }
    if (node_mode == "none") {
        std::printf("Q2 no scene node at all: setDirection on a manager-owned light\n");
    }

    // ── Q4/Q5/Q7: the frames ─────────────────────────────────────────────
    if (timed_frames > 0) {
        const double started = now_us();
        for (int i = 0; i < timed_frames; ++i) root.renderOneFrame();
        const double per_frame = (now_us() - started) / static_cast<double>(timed_frames);
        std::printf("Q6 frame cost with %d light(s), %d frame(s): %.1f us/frame\n", light_count,
                    timed_frames, per_frame);
        return 0;
    }

    for (int settle = 0; settle < 4; ++settle) root.renderOneFrame();
    Frame with_light;
    if (!grab(&root, downloader, with_light)) {
        std::printf("Q4 no frame could be downloaded\n");
        return 2;
    }

    // Light off: destroy them all and grab again.
    for (Ogre::Light *light : lights) scene->destroyLight(light);
    for (Ogre::SceneNode *node : light_nodes) scene->destroySceneNode(node);
    for (int settle = 0; settle < 4; ++settle) root.renderOneFrame();
    Frame without_light;
    if (!grab(&root, downloader, without_light)) {
        std::printf("Q4 no second frame could be downloaded\n");
        return 2;
    }

    const RegionStats lit_on = region(with_light, kSphereCx[0], kSphereRadiusPx);
    const RegionStats lit_off = region(without_light, kSphereCx[0], kSphereRadiusPx);
    std::printf("Q4 lit sphere: light ON  (powerScale %.2f) %zu px, mean %.2f, max %d, min %d\n",
                power, lit_on.count, lit_on.mean, lit_on.max_channel, lit_on.min_channel);
    std::printf("Q4 lit sphere: light OFF %zu px, mean %.2f, max %d, min %d\n", lit_off.count,
                lit_off.mean, lit_off.max_channel, lit_off.min_channel);

    const Halves h = halves(with_light, kSphereCx[0]);
    std::printf("Q5 hemispheres: lit(right) mean %.2f over %zu px, dark(left) mean %.2f over %zu px, "
                "ratio %.3f, mid band %.2f\n",
                h.lit_mean, h.lit_count, h.dark_mean, h.dark_count,
                h.dark_mean > 0.01 ? h.lit_mean / h.dark_mean : 0.0, h.mid_mean);
    std::printf("Q5 profile left->right: ");
    for (int band = 0; band < 10; ++band) {
        std::printf("%.1f%s", h.profile_count[band]
                                  ? h.profile[band] / h.profile_count[band]
                                  : 0.0,
                    band == 9 ? "\n" : " ");
    }
    const Halves h_off = halves(without_light, kSphereCx[0]);
    std::printf("Q5 hemispheres with the light off: left %.2f, right %.2f (a flat sphere is the "
                "control)\n",
                h_off.dark_mean, h_off.lit_mean);

    const bool emissive_same = region_identical(with_light, without_light, kSphereCx[1],
                                                kSphereRadiusPx);
    const bool unlit_same =
        region_identical(with_light, without_light, kSphereCx[2], kSphereRadiusPx);
    const RegionStats emissive_on = region(with_light, kSphereCx[1], kSphereRadiusPx);
    const RegionStats unlit_on = region(with_light, kSphereCx[2], kSphereRadiusPx);
    std::printf("Q7 emissive-only PBS sphere: %s (mean %.2f with the light, %zu px)\n",
                emissive_same ? "byte-identical with and without the light" : "CHANGED by the light",
                emissive_on.mean, emissive_on.count);
    std::printf("Q7 Unlit sphere: %s (mean %.2f with the light, %zu px)\n",
                unlit_same ? "byte-identical with and without the light" : "CHANGED by the light",
                unlit_on.mean, unlit_on.count);

    return 0;
}
