// probe_procedural.cpp — can a mesh be built in memory and drawn?
//
// Round 5.5 runs this before the verb is written, because the answers decide
// the verb's shape and three of them are not guessable from the headers:
//
//   Q1  Ogre::v1::MeshManager::createManual — the exact signature, and what
//       state a manual v1 mesh is in when Mesh2::importV1 calls load() on it.
//   Q2  Does createByImportingV1 accept a v1::Mesh built by hand — a submesh,
//       a vertex declaration, buffers — with no file involved?
//   Q3  Which vertex element sets does an Unlit datablock actually render?
//       Position alone, position+normal, position+normal+uv.
//   Q4  The pixel statistics of a procedural triangle, and the minimum
//       construction sequence that gets there: the two calls the file path
//       gets for free from the serializer (`_setBounds`,
//       `prepareForShadowMapping`) are measured by omission, each in a child
//       process so a crash is a datum rather than the end of the probe.
//
//   g++ -std=c++17 -O1 -isystem /usr/include/OGRE-Next \
//       -isystem /usr/include/OGRE-Next/Hlms/Common \
//       -isystem /usr/include/OGRE-Next/Hlms/Unlit \
//       tests/probe_procedural.cpp -o build/probe-procedural/probe_procedural \
//       -lOgreNextMain -lOgreNextHlmsUnlit -lOgreNextHlmsCommon -lpthread
//   ./probe_procedural /usr/lib/OGRE-Next [--gl3plus]
//
// The two negative controls re-exec this same binary with --variant=…, which
// runs the conversion under the NULL render system and exits: the parent reads
// the child's exit status instead of sharing its fate.

#include <OgreArchiveManager.h>
#include <OgreAxisAlignedBox.h>
#include <OgreCamera.h>
#include <OgreColourValue.h>
#include <OgreHardwareBufferManager.h>
#include <OgreHardwareIndexBuffer.h>
#include <OgreHardwareVertexBuffer.h>
#include <OgreHlmsDatablock.h>
#include <OgreHlmsManager.h>
#include <OgreImage2.h>
#include <OgreItem.h>
#include <OgreLogManager.h>
#include <OgreMesh.h>
#include <OgreMesh2.h>
#include <OgreMeshManager.h>
#include <OgreMeshManager2.h>
#include <OgreRenderSystem.h>
#include <OgreResourceGroupManager.h>
#include <OgreRoot.h>
#include <OgreSceneManager.h>
#include <OgreSceneNode.h>
#include <OgreSubMesh.h>
#include <OgreTextureBox.h>
#include <OgreTextureGpu.h>
#include <OgreVertexIndexData.h>
#include <OgreWindow.h>

#include <Compositor/OgreCompositorManager2.h>
#include <Compositor/OgreCompositorWorkspace.h>
#include <Hlms/Pbs/OgreHlmsPbs.h>
#include <Hlms/Unlit/OgreHlmsUnlit.h>
#include <Hlms/Unlit/OgreHlmsUnlitDatablock.h>

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <stdexcept>
#include <string>
#include <sys/wait.h>
#include <vector>

namespace {

const char *const kMedia = "/usr/share/OGRE-Next/Media";
const char *const kGroup = "General";
int failures = 0;

void ok(int step, const std::string &what) {
    std::printf("PROCEDURAL step %d: ok — %s\n", step, what.c_str());
}
void failed(int step, const std::string &what, const std::string &why) {
    std::printf("PROCEDURAL step %d: FAILED (%s) — %s\n", step, what.c_str(), why.c_str());
    failures += 1;
}

struct PixelStats {
    size_t non_background = 0;
    float mean_r = 0, mean_g = 0, mean_b = 0;
};

PixelStats scan(const Ogre::TextureBox &box) {
    PixelStats stats;
    double sum[3] = {0, 0, 0};
    const uint8_t *pixels = static_cast<const uint8_t *>(box.data);
    for (uint32_t y = 0; y < box.height; ++y) {
        const uint8_t *row = pixels + y * box.bytesPerRow;
        for (uint32_t x = 0; x < box.width; ++x) {
            const uint8_t *p = row + x * box.bytesPerPixel;
            if (p[0] < 40 && p[1] < 40 && p[2] < 40) continue; // the workspace's 0.1 grey
            stats.non_background += 1;
            sum[0] += p[0];
            sum[1] += p[1];
            sum[2] += p[2];
        }
    }
    if (stats.non_background > 0) {
        const double n = static_cast<double>(stats.non_background);
        stats.mean_r = static_cast<float>(sum[0] / n);
        stats.mean_g = static_cast<float>(sum[1] / n);
        stats.mean_b = static_cast<float>(sum[2] / n);
    }
    return stats;
}

// ── the readback, with the retry it turned out to need ───────────────────
//
// The window's download is a pull: arm it, render a frame, read what came back.
// **One frame is not always enough.** The first version of this probe pulled
// once per case and read 0 non-background pixels in roughly one run in four —
// on a different format each time, which is what said the flake was in the
// readback rather than in any vertex format: a frame can be downloaded before
// the item that was just created is in it. So the pull is repeated, with a few
// frames in between, until pixels arrive or the budget runs out, and the number
// of attempts is printed next to the count — a 0 after the budget is a real 0.
constexpr int kGrabAttempts = 20;

bool grab_once(Ogre::Root *root, Ogre::Window *window, PixelStats *out) {
    window->setWantsToDownload(true);
    window->setManualSwapRelease(true);
    root->renderOneFrame();
    if (!window->canDownloadData()) {
        window->performManualRelease();
        return false;
    }
    Ogre::Image2 image;
    image.convertFromTexture(window->getTexture(), 0u, window->getTexture()->getNumMipmaps() - 1u);
    *out = scan(image.getData(0));
    window->performManualRelease();
    return true;
}

/// The pull, repeated until the scene is in the frame. Returns the attempt that
/// worked, or 0 when the budget ran out.
int grab_non_empty(Ogre::Root *root, Ogre::Window *window, PixelStats *out) {
    for (int attempt = 1; attempt <= kGrabAttempts; ++attempt) {
        if (grab_once(root, window, out) && out->non_background > 0) return attempt;
        for (int frame = 0; frame < 3; ++frame) root->renderOneFrame();
    }
    return 0;
}

// ── the mesh, built by hand ──────────────────────────────────────────────
//
// One triangle, three vertices. `normals`/`uvs` add elements to the
// declaration and the interleaved buffer, so the format question (Q3) is the
// same code with the flags moved. Everything here is 1.x API under namespace
// v1: VertexData, IndexData, the buffer manager, the element enums are the
// only pieces still in namespace Ogre (VET_/VES_).

struct MeshSpec {
    const char *name;
    bool normals;
    bool uvs;
    bool bounds;
    bool shadow_buffers;
};

Ogre::v1::MeshPtr build_v1_mesh(const MeshSpec &spec) {
    using Ogre::v1::HardwareBuffer;
    const float positions[9] = {-1.0f, -1.0f, 0.0f, 1.0f, -1.0f, 0.0f, 0.0f, 1.0f, 0.0f};

    Ogre::v1::MeshPtr mesh = Ogre::v1::MeshManager::getSingleton().createManual(spec.name, kGroup);
    Ogre::v1::SubMesh *sub = mesh->createSubMesh();
    sub->useSharedVertices = false;
    sub->operationType = Ogre::OT_TRIANGLE_LIST;
    sub->setMaterialName("probe-procedural-material");

    sub->vertexData[Ogre::VpNormal] =
        OGRE_NEW Ogre::v1::VertexData(Ogre::v1::HardwareBufferManager::getSingletonPtr());
    Ogre::v1::VertexData *vd = sub->vertexData[Ogre::VpNormal];
    vd->vertexStart = 0;
    vd->vertexCount = 3;

    const size_t f3 = Ogre::v1::VertexElement::getTypeSize(Ogre::VET_FLOAT3);
    const size_t f2 = Ogre::v1::VertexElement::getTypeSize(Ogre::VET_FLOAT2);
    Ogre::v1::VertexDeclaration *decl = vd->vertexDeclaration;
    size_t stride = 0;
    decl->addElement(0, stride, Ogre::VET_FLOAT3, Ogre::VES_POSITION);
    stride += f3;
    if (spec.normals) {
        decl->addElement(0, stride, Ogre::VET_FLOAT3, Ogre::VES_NORMAL);
        stride += f3;
    }
    if (spec.uvs) {
        decl->addElement(0, stride, Ogre::VET_FLOAT2, Ogre::VES_TEXTURE_COORDINATES, 0);
        stride += f2;
    }

    Ogre::v1::HardwareVertexBufferSharedPtr vbuf =
        Ogre::v1::HardwareBufferManager::getSingleton().createVertexBuffer(
            stride, 3, HardwareBuffer::HBU_STATIC_WRITE_ONLY, /* useShadowBuffer */ false);
    sub->vertexData[Ogre::VpNormal]->vertexBufferBinding->setBinding(0, vbuf);
    {
        float *v = static_cast<float *>(vbuf->lock(HardwareBuffer::HBL_DISCARD));
        for (int i = 0; i < 3; ++i) {
            *v++ = positions[i * 3 + 0];
            *v++ = positions[i * 3 + 1];
            *v++ = positions[i * 3 + 2];
            if (spec.normals) {
                *v++ = 0.0f;
                *v++ = 0.0f;
                *v++ = 1.0f;
            }
            if (spec.uvs) { // (0,0) (1,0) (0.5,1): inside the unit square
                *v++ = i == 1 ? 1.0f : (i == 2 ? 0.5f : 0.0f);
                *v++ = i == 2 ? 1.0f : 0.0f;
            }
        }
        vbuf->unlock();
    }

    sub->indexData[Ogre::VpNormal] = OGRE_NEW Ogre::v1::IndexData();
    Ogre::v1::IndexData *id = sub->indexData[Ogre::VpNormal];
    id->indexStart = 0;
    id->indexCount = 3;
    Ogre::v1::HardwareIndexBufferSharedPtr ibuf =
        Ogre::v1::HardwareBufferManager::getSingleton().createIndexBuffer(
            Ogre::v1::HardwareIndexBuffer::IT_16BIT, 3, HardwareBuffer::HBU_STATIC_WRITE_ONLY,
            /* useShadowBuffer */ false);
    {
        uint16_t *idx = static_cast<uint16_t *>(ibuf->lock(HardwareBuffer::HBL_DISCARD));
        idx[0] = 0;
        idx[1] = 1;
        idx[2] = 2;
        ibuf->unlock();
    }
    id->indexBuffer = ibuf;

    if (spec.bounds) {
        mesh->_setBounds(Ogre::AxisAlignedBox(-1.0f, -1.0f, 0.0f, 1.0f, 1.0f, 0.0f), false);
    }
    if (spec.shadow_buffers) mesh->prepareForShadowMapping(false);
    return mesh;
}

Ogre::MeshPtr to_mesh2(const Ogre::v1::MeshPtr &v1, const Ogre::String &name) {
    // No file is involved anywhere here: the vertex and index bytes are in
    // buffers this program filled. createByImportingV1 is the same door the
    // loader's byte path uses, which is the point of Q2.
    Ogre::MeshPtr mesh = Ogre::MeshManager::getSingleton().createByImportingV1(
        name, kGroup, v1.get(), false, false, false);
    mesh->load();
    return mesh;
}

// ── the two negative controls, each its own process ──────────────────────
//
// A missing `_setBounds` and a missing `prepareForShadowMapping` are the two
// ways a hand-built mesh differs from a deserialized one. Both are measured by
// omission in a child process: the child prints and exits 0 if the conversion
// survives, and anything else (a signal, an abort) is reported by the parent as
// the reason the call is in the sequence.
int run_variant(const std::string &variant) {
    const bool bounds = variant != "no-bounds";
    const bool shadow = variant != "no-shadow";
    try {
        MeshSpec spec{"probe-variant", /* normals */ true, /* uvs */ true, bounds, shadow};
        Ogre::MeshPtr mesh = to_mesh2(build_v1_mesh(spec), "probe-variant-mesh");
        std::printf("PROCEDURAL variant %s: conversion survived, %u submesh(es)\n", variant.c_str(),
                    mesh->getNumSubMeshes());
        return 0;
    } catch (const std::exception &e) {
        std::printf("PROCEDURAL variant %s: threw — %s\n", variant.c_str(), e.what());
        return 3;
    }
}

} // namespace

int main(int argc, char **argv) {
    std::setvbuf(stdout, nullptr, _IONBF, 0);
    const std::string plugin_dir = argc > 1 ? argv[1] : "/usr/lib/OGRE-Next";
    std::string variant;
    bool gl3plus = false;
    for (int i = 2; i < argc; ++i) {
        const std::string arg = argv[i];
        if (arg == "--gl3plus") gl3plus = true;
        else if (arg.rfind("--variant=", 0) == 0) variant = arg.substr(10);
    }

    {
        std::ofstream cfg("procedural_plugins.cfg");
        cfg << "PluginFolder=" << plugin_dir << "\n"
            << (gl3plus ? "Plugin=RenderSystem_GL3Plus\n" : "Plugin=RenderSystem_NULL\n");
    }
    Ogre::LogManager *logs = new Ogre::LogManager();
    logs->createLog("procedural_probe.log", true, false);

    Ogre::Root root(nullptr, "procedural_plugins.cfg", "procedural_probe.cfg",
                    "procedural_probe.log", "procedural");
    const char *rs_name = gl3plus ? "OpenGL 3+ Rendering Subsystem" : "NULL Rendering Subsystem";
    Ogre::RenderSystem *rs = root.getRenderSystemByName(rs_name);
    if (!rs) {
        std::printf("PROCEDURAL: no render system named %s\n", rs_name);
        return 2;
    }
    std::printf("PROCEDURAL: render system '%s'\n", rs_name);
    root.setRenderSystem(rs);
    root.initialise(false);
    Ogre::Window *window = root.createRenderWindow("procedural-probe", 320, 240, false, nullptr);
    Ogre::SceneManager *scene = root.createSceneManager(Ogre::ST_GENERIC, 1u, "procedural-mgr");

    if (!variant.empty()) return run_variant(variant);

    // ── Q1: the signature, from the installed headers ────────────────────
    std::printf(
        "PROCEDURAL Q1: Ogre::v1::MeshManager::createManual(const String &name, const String "
        "&groupName, ManualResourceLoader *loader = 0) -> v1::MeshPtr  [OgreMeshManager.h:179]\n"
        "PROCEDURAL Q1: Ogre::MeshManager::createByImportingV1(const String &name, const String "
        "&groupName, v1::Mesh *mesh, bool halfPos, bool halfTexCoords, bool qTangents, bool halfPose "
        "= true) -> MeshPtr  [OgreMeshManager2.h:220]\n"
        "PROCEDURAL Q1: Mesh2::importV1 calls mesh->load() first (OgreMesh2.cpp:497); a manual "
        "resource's load() never reaches Mesh::loadImpl(), which is the one that demands a disk "
        "stream, so a hand-built mesh has nothing to satisfy there\n");

    // ── the Hlms (both, for the reason below) ────────────────────────────
    Ogre::HlmsUnlitDatablock *material = nullptr;
    try {
        Ogre::ArchiveManager &archives = Ogre::ArchiveManager::getSingleton();
        Ogre::HlmsManager *hlms_manager = root.getHlmsManager();
        // Unlit is what this probe draws with; PBS is registered because item
        // creation needs it even so. A Mesh2 submesh carries a material name,
        // and when no .material script defines it, Renderable::setMaterialName
        // falls back to HlmsManager::getDefaultDatablock(), which indexes
        // mRegisteredHlms[mDefaultHlmsType] — and mDefaultHlmsType is HLMS_PBS
        // (OgreHlmsManager.cpp:620, :48) with no null check. Registering Unlit
        // alone segfaults inside Item's constructor. Measured here: the first
        // version of this probe did exactly that.
        Ogre::String unlit_main, pbs_main;
        Ogre::StringVector unlit_libs, pbs_libs;
        Ogre::HlmsUnlit::getDefaultPaths(unlit_main, unlit_libs);
        Ogre::HlmsPbs::getDefaultPaths(pbs_main, pbs_libs);
        Ogre::ArchiveVec unlit_library, pbs_library;
        for (const Ogre::String &path : unlit_libs) {
            unlit_library.push_back(archives.load(std::string(kMedia) + "/" + path, "FileSystem", true));
        }
        for (const Ogre::String &path : pbs_libs) {
            pbs_library.push_back(archives.load(std::string(kMedia) + "/" + path, "FileSystem", true));
        }
        Ogre::HlmsUnlit *unlit = new Ogre::HlmsUnlit(
            archives.load(std::string(kMedia) + "/" + unlit_main, "FileSystem", true), &unlit_library);
        hlms_manager->registerHlms(unlit);
        hlms_manager->registerHlms(new Ogre::HlmsPbs(
            archives.load(std::string(kMedia) + "/" + pbs_main, "FileSystem", true), &pbs_library));

        Ogre::HlmsMacroblock macroblock;
        Ogre::HlmsBlendblock blendblock;
        Ogre::HlmsParamVec params;
        material = static_cast<Ogre::HlmsUnlitDatablock *>(
            unlit->createDatablock("probe-red", "probe-red", macroblock, blendblock, params));
        material->setUseColour(true);
        material->setColour(Ogre::ColourValue(0.9f, 0.2f, 0.2f, 1.0f));
        std::printf("PROCEDURAL note: registering one Hlms is not enough — item creation for a mesh "
                    "whose submesh material name resolves to nothing falls back to the default "
                    "datablock, and that lookup is unconditional on HLMS_PBS (segfault measured)" "\n");
        ok(2, "HlmsUnlit + HlmsPbs from their own getDefaultPaths(), plus one red datablock");
    } catch (const std::exception &e) {
        failed(2, "Hlms", e.what());
        return 4;
    }

    Ogre::CompositorWorkspace *workspace = nullptr;
    if (gl3plus) {
        try {
            Ogre::CompositorManager2 *compositors = root.getCompositorManager2();
            compositors->createBasicWorkspaceDef("probe-workspace",
                                                 Ogre::ColourValue(0.1f, 0.1f, 0.1f, 1.0f));
            Ogre::Camera *camera = scene->createCamera("probe-camera");
            camera->setPosition(0.0f, 0.0f, 4.0f);
            camera->lookAt(0.0f, 0.0f, 0.0f);
            camera->setNearClipDistance(0.1f);
            camera->setAutoAspectRatio(true);
            workspace = compositors->addWorkspace(scene, window->getTexture(), camera, "probe-workspace",
                                                  true);
            ok(3, "camera at (0,0,4) looking at the origin, and a workspace over it");
        } catch (const std::exception &e) {
            failed(3, "camera/workspace", e.what());
            return 5;
        }
    } else {
        ok(3, "no workspace under NULL: nothing presents, the conversions still run");
    }

    // ── Q2: a hand-built v1 mesh through the conversion ──────────────────
    try {
        MeshSpec spec{"probe-full", true, true, true, true};
        Ogre::v1::MeshPtr v1 = build_v1_mesh(spec);
        Ogre::MeshPtr mesh = to_mesh2(v1, "probe-full-mesh");
        ok(4, "hand-built v1::Mesh (#" + std::to_string(mesh->getNumSubMeshes()) + " submesh, 3 "
                  "vertices, 3 indices) converted to Mesh2 '" + mesh->getName() + "', bounds " +
                  std::to_string(mesh->getAabb().getMinimum().x) + ".." +
                  std::to_string(mesh->getAabb().getMaximum().x));
    } catch (const std::exception &e) {
        failed(4, "hand-built mesh conversion", e.what());
    }

    // ── Q3 and Q4: what renders, and what it looks like ──────────────────
    struct FormatCase {
        const char *label;
        bool normals;
        bool uvs;
    };
    const FormatCase cases[3] = {{"position", false, false},
                                 {"position+normal", true, false},
                                 {"position+normal+uv", true, true}};
    for (const FormatCase &format : cases) {
        try {
            const std::string v1_name = std::string("probe-format-") + format.label;
            const std::string mesh_name = std::string("mesh-") + format.label;
            MeshSpec spec{v1_name.c_str(), format.normals, format.uvs, true, true};
            Ogre::MeshPtr mesh = to_mesh2(build_v1_mesh(spec), mesh_name);
            Ogre::Item *item = scene->createItem(mesh, Ogre::SCENE_DYNAMIC);
            item->setDatablock(material);
            Ogre::SceneNode *node =
                scene->getRootSceneNode(Ogre::SCENE_DYNAMIC)->createChildSceneNode(Ogre::SCENE_DYNAMIC);
            node->attachObject(item);

            if (!gl3plus) {
                ok(5, std::string("format ") + format.label + ": converted and submitted (no pixels "
                                  "under NULL)");
            } else {
                for (int frame = 0; frame < 5; ++frame) root.renderOneFrame();
                PixelStats stats;
                const int attempts = grab_non_empty(&root, window, &stats);
                std::printf("PROCEDURAL Q3: format %-19s -> %zu non-background pixels, mean rgb "
                            "%.1f/%.1f/%.1f (%s)\n",
                            format.label, stats.non_background, stats.mean_r, stats.mean_g,
                            stats.mean_b,
                            attempts == 0 ? "no pixels after the whole budget"
                                          : ("attempt " + std::to_string(attempts)).c_str());
            }
            scene->destroyItem(item);
            Ogre::v1::MeshManager::getSingleton().remove(mesh->getName());
        } catch (const std::exception &e) {
            failed(5, std::string("format ") + format.label, e.what());
        }
    }

    // ── Q4: the triangle, and the two calls the serializer would have made ─
    //
    // The headline is the canonical triangle — position, normal and uv, with
    // the bounds and the shadow-buffer set — rendered and read back. The two
    // controls then remove one call each: `_setBounds` here, because a mesh
    // with no bounds is a culling question rather than a crash, and
    // `prepareForShadowMapping` in a child process, because that one reaches
    // into a null pass-1 buffer and takes the process with it.
    if (gl3plus) {
        try {
            MeshSpec spec{"probe-triangle", true, true, /* bounds */ true, /* shadow */ true};
            Ogre::MeshPtr mesh = to_mesh2(build_v1_mesh(spec), "mesh-triangle");
            Ogre::Item *item = scene->createItem(mesh, Ogre::SCENE_DYNAMIC);
            item->setDatablock(material);
            Ogre::SceneNode *node = scene->getRootSceneNode(Ogre::SCENE_DYNAMIC)
                                        ->createChildSceneNode(Ogre::SCENE_DYNAMIC);
            node->attachObject(item);
            for (int frame = 0; frame < 5; ++frame) root.renderOneFrame();
            PixelStats stats;
            const int attempts = grab_non_empty(&root, window, &stats);
            std::printf("PROCEDURAL Q4: procedural triangle -> %zu non-background pixels, mean rgb "
                        "%.1f/%.1f/%.1f, at 320x240 with the camera at z=4 (attempt %d)\n",
                        stats.non_background, stats.mean_r, stats.mean_g, stats.mean_b, attempts);
            scene->destroyItem(item);
        } catch (const std::exception &e) {
            failed(6, "procedural triangle render", e.what());
        }

        try {
            MeshSpec spec{"probe-nobounds", true, true, /* bounds */ false, /* shadow */ true};
            Ogre::MeshPtr mesh = to_mesh2(build_v1_mesh(spec), "mesh-nobounds");
            Ogre::Item *item = scene->createItem(mesh, Ogre::SCENE_DYNAMIC);
            item->setDatablock(material);
            Ogre::SceneNode *node = scene->getRootSceneNode(Ogre::SCENE_DYNAMIC)
                                        ->createChildSceneNode(Ogre::SCENE_DYNAMIC);
            node->attachObject(item);
            for (int frame = 0; frame < 5; ++frame) root.renderOneFrame();
            PixelStats stats;
            const int attempts = grab_non_empty(&root, window, &stats);
            std::printf("PROCEDURAL Q4: control without _setBounds -> %zu non-background pixels "
                        "(%s, attempt %d)\n",
                        stats.non_background,
                        stats.non_background == 0 ? "culled: the call is required"
                                                  : "rendered anyway: the call is belt-and-braces",
                        attempts);
            scene->destroyItem(item);
        } catch (const std::exception &e) {
            failed(7, "control without _setBounds", e.what());
        }
    } else {
        ok(6, "no pixels under NULL: Q4's render and its bounds control are skipped");
    }

    // The calls the file path gets from the serializer, each removed in turn.
    const std::pair<const char *, const char *> controls[2] = {
        {"_setBounds", "no-bounds"}, {"prepareForShadowMapping", "no-shadow"}};
    for (const std::pair<const char *, const char *> &control : controls) {
        const std::string call = control.first;
        const std::string each = control.second;
        const std::string command = std::string(argv[0]) + " " + plugin_dir + " --variant=" + each +
                                    " > /tmp/probe_variant_" + each + ".txt 2>&1";
        const int status = std::system(command.c_str());
        std::ifstream captured(std::string("/tmp/probe_variant_") + each + ".txt");
        std::string line;
        std::string last;
        while (std::getline(captured, line)) {
            if (line.rfind("PROCEDURAL variant", 0) == 0) last = line;
        }
        if (WIFSIGNALED(status)) {
            std::printf("PROCEDURAL Q4: conversion without %-22s -> killed by signal %d: the call is "
                        "required\n",
                        call.c_str(), WTERMSIG(status));
        } else if (WEXITSTATUS(status) != 0) {
            std::printf("PROCEDURAL Q4: conversion without %-22s -> died (exit %d, 128 + SIGSEGV): "
                        "the call is required\n",
                        call.c_str(), WEXITSTATUS(status));
        } else {
            std::printf("PROCEDURAL Q4: conversion without %-22s -> survived%s\n", call.c_str(),
                        last.empty() ? "" : ("; " + last).c_str());
        }
    }

    // ── teardown ─────────────────────────────────────────────────────────
    try {
        (void)workspace;
        scene->destroyAllCameras();
        root.shutdown();
        ok(8, "teardown clean");
    } catch (const std::exception &e) {
        failed(8, "teardown", e.what());
    }
    std::printf("PROCEDURAL: %s (%d failure(s))\n", failures == 0 ? "all steps ok" : "FAILURES",
                failures);
    return failures == 0 ? 0 : 1;
}
