// hlms-skin — the HlmsPbs subclass mechanism, measured end to end.
//
//	hlms-skin <resource-dir> [frames] [render-system] [off]
//
// Registers PBS and HlmsTensionSkin side by side, draws N identical Items that share
// one mesh and one (subclass-made) datablock at one scene node, and reads the frame
// back from the window. With the channel on, the fill gives each object a different
// record and the shader displaces each object by it, so N objects must appear in N
// different places. With "off" they must collapse into one.
//
// The load-bearing run:
//	hlms-skin <dir> 10 "OpenGL 3+ Rendering Subsystem"        # 3 blobs, ~3x the pixels
//	hlms-skin <dir> 10 "OpenGL 3+ Rendering Subsystem" off    # 1 blob
//
// Build and run: see README.md beside this file.

#include "HlmsTensionSkin.h"

#include <Hlms/Pbs/OgreHlmsPbs.h>
#include <Hlms/Unlit/OgreHlmsUnlit.h>
#include <OgreArchiveManager.h>
#include <OgreCamera.h>
#include <Compositor/OgreCompositorManager2.h>
#include <OgreItem.h>
#include <OgreLogManager.h>
#include <OgreMesh2.h>
#include <OgreMeshManager2.h>
#include <Animation/OgreSkeletonDef.h>
#include <OgreWindow.h>
#include <OgreImage2.h>
#include <OgreTextureGpu.h>
#include <OgreTextureBox.h>
#include <OgreResourceGroupManager.h>
#include <OgreRoot.h>
#include <OgreSceneManager.h>
#include <OgreSubItem.h>
#include <OgreViewport.h>

#include <cmath>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <string>
#include <vector>

static void step(const std::string &s) { std::cout << "[hlms-skin] " << s << std::endl; }

int main(int argc, char **argv) {
    if (argc < 2) {
        std::cerr << "usage: hlms-skin <resource-dir> [frames] [render-system] [off]\n"
                     "  <resource-dir> must contain characterMedium-v2.mesh (and, for the\n"
                     "  rigged run, its sibling characterMedium.skeleton)\n"
                     "  [off] runs the contrast case: every record zero\n" << std::endl;
        return 2;
    }
    const std::string resDir = argv[1];
    const int frames = (argc > 2) ? std::atoi(argv[2]) : 5;
    const std::string renderSystemName =
        (argc > 3 && argv[3][0]) ? argv[3] : "OpenGL 3+ Rendering Subsystem";
    // argv[4] == "off" zeroes every record: the contrast run.
    Ogre::HlmsTensionSkin::sChannelEnabled = !(argc > 4 && std::string(argv[4]) == "off");
    using namespace Ogre;

    // The scratch directory (the log and the shader dump) is fixed rather than random:
    // the dump is the evidence a reader greps afterwards.
    const std::string scratch = "/tmp/hlms-skin";
    std::filesystem::create_directories(scratch + "/dump");

    char tmpl[] = "/tmp/hlms-skin/run-XXXXXX";
    const std::string runDir = mkdtemp(tmpl) ? std::string(tmpl) : scratch;
    {
        std::ofstream cfg(runDir + "/plugins.cfg");
        cfg << "PluginFolder=/usr/lib/OGRE-Next\n";
        cfg << (renderSystemName == "Vulkan Rendering Subsystem" ? "Plugin=RenderSystem_Vulkan\n"
                                                                 : "Plugin=RenderSystem_GL3Plus\n");
    }
    LogManager *lm = new LogManager();
    lm->createLog(runDir + "/Ogre.log", true, false);

    Root *root = new Root(nullptr, runDir + "/plugins.cfg", runDir + "/ogre.cfg",
                          runDir + "/Ogre.log", "hlms-skin");
    root->setRenderSystem(root->getRenderSystemByName(renderSystemName));
    step("render system: " + renderSystemName);
    root->initialise(false);
    Window *window = root->createRenderWindow("hlms-skin-window", 320, 240, false, nullptr);
    SceneManager *scene = root->createSceneManager(ST_GENERIC, 1u, "hlms-skin-scene");

    // Two Hlmses, side by side: PBS first, then ours, each on its own HlmsTypes slot.
    const std::string media = "/usr/share/OGRE-Next/Media";
    ArchiveManager &archives = ArchiveManager::getSingleton();
    String hlmsMain;
    StringVector hlmsLibs;
    HlmsPbs::getDefaultPaths(hlmsMain, hlmsLibs);
    ArchiveVec library;
    for (const String &p : hlmsLibs)
        library.push_back(archives.load(media + "/" + p, "FileSystem", true));
    Archive *dataFolder = archives.load(media + "/" + hlmsMain, "FileSystem", true);

    HlmsPbs *pbs = new HlmsPbs(dataFolder, &library);
    root->getHlmsManager()->registerHlms(pbs);
    HlmsTensionSkin *skin = new HlmsTensionSkin(dataFolder, &library);
    root->getHlmsManager()->registerHlms(skin);
    step("HlmsPbs and HlmsTensionSkin registered");

    // setDebugOutputPath does NOT create the directory; create_directories above did.
    skin->setDebugOutputPath(true, true, (scratch + "/dump/").c_str());
    step("shader dump: " + scratch + "/dump/");

    ResourceGroupManager::getSingleton().addResourceLocation(resDir, "FileSystem", "General", true);
    MeshPtr mesh;
    try {
        mesh = MeshManager::getSingleton().load("characterMedium-v2.mesh", "General");
    } catch (const Exception &e) {
        step(std::string("mesh load THREW: ") + e.getFullDescription());
        return 3;
    }
    step("mesh: hasSkeleton=" + std::string(mesh->hasSkeleton() ? "true" : "false") +
         " getSkeleton()=" + std::string(mesh->getSkeleton() ? "PRESENT" : "NULL"));

    // Three identical Items: one mesh, one datablock, one scene node. Nothing but the
    // per-object record can tell them apart on screen.
    HlmsMacroblock macroblock;
    HlmsBlendblock blendblock;
    HlmsParamVec params;
    HlmsTensionSkinDatablock *db = static_cast<HlmsTensionSkinDatablock *>(
        skin->createDatablock(IdString("tensionSkinDb"), "tensionSkinDb", macroblock, blendblock,
                              params));
    db->setTensionFlag(0xC0FFEEu);

    SceneNode *node = scene->getRootSceneNode()->createChildSceneNode();
    for (int i = 0; i < 3; ++i) {
        Item *item = scene->createItem(mesh);
        item->setDatablock(db);
        node->attachObject(item);
    }
    step("3 items attached: same mesh, same datablock, same node; datablockIsOurs=" +
         std::string(dynamic_cast<HlmsTensionSkinDatablock *>(
                         static_cast<Item *>(node->getAttachedObject(0))
                             ->getSubItem(0)
                             ->getDatablock())
                         ? "true"
                         : "false"));

    Camera *camera = scene->createCamera("hlms-skin-camera");
    camera->setPosition(Vector3(0, 0.9f, 14.0f));
    camera->lookAt(Vector3(0, 0.9f, 0));
    camera->setNearClipDistance(0.1f);
    // OGRE-Next 3.0 has no Window::addViewport; the workspace binds camera to window texture.
    {
        CompositorManager2 *compositorManager = root->getCompositorManager2();
        const String workspaceName = "hlms-skin workspace";
        compositorManager->createBasicWorkspaceDef(workspaceName, ColourValue(0.1f, 0.2f, 0.3f));
        compositorManager->addWorkspace(scene, window->getTexture(), camera, workspaceName, true);
    }

    for (int i = 0; i < frames; ++i)
        root->renderOneFrame();
    step("rendered " + StringConverter::toString(frames) + " frames; records written = " +
         StringConverter::toString(HlmsTensionSkin::sObjectCounter));

    // ── the readback ─────────────────────────────────────────────────────────
    // The recipe from OgreWindow.h:174-185: ask to download, take the manual swap
    // release, render a frame, then convert the window's own texture to an Image2.
    {
        bool haveFrame = false;
        window->setWantsToDownload(true);
        window->setManualSwapRelease(true);
        for (int attempt = 0; attempt < 4 && !haveFrame; ++attempt) {
            root->renderOneFrame();
            haveFrame = window->canDownloadData();
        }
        step("canDownloadData() = " + std::string(haveFrame ? "true" : "false"));
        if (haveFrame) {
            Image2 img;
            TextureGpu *tex = window->getTexture();
            img.convertFromTexture(tex, 0u, tex->getNumMipmaps() - 1u);
            const TextureBox box = img.getData(0);
            const size_t w = box.width, h = box.height, bpp = box.bytesPerPixel;
            const uint8_t *px = static_cast<const uint8_t *>(box.data);
            auto at = [&](size_t x, size_t y, size_t c) -> int {
                return int(px[y * box.bytesPerRow + x * bpp + c]);
            };
            const int bg[4] = {at(0, 0, 0), at(0, 0, 1), at(0, 0, 2), at(0, 0, 3)};
            step("image " + StringConverter::toString(w) + "x" + StringConverter::toString(h) +
                 ", background (0,0) = (" + StringConverter::toString(bg[0]) + ", " +
                 StringConverter::toString(bg[1]) + ", " + StringConverter::toString(bg[2]) + ")");

            unsigned long long sum = 0;
            std::vector<int> columnCount(w, 0);
            long centroidNum = 0, centroidDen = 0;
            size_t leftmost = w, rightmost = 0;
            for (size_t y = 0; y < h; ++y) {
                for (size_t x = 0; x < w; ++x) {
                    const int r = at(x, y, 0), g = at(x, y, 1), b = at(x, y, 2);
                    sum = sum * 131ull + (unsigned long long)(r + g + b);
                    if (std::abs(r - bg[0]) + std::abs(g - bg[1]) + std::abs(b - bg[2]) > 30) {
                        ++columnCount[x];
                        centroidNum += long(x);
                        ++centroidDen;
                        if (x < leftmost) leftmost = x;
                        if (x > rightmost) rightmost = x;
                    }
                }
            }
            step("frame checksum = " + StringConverter::toString(sum));
            step("non-background pixels = " + StringConverter::toString(centroidDen) +
                 "  columns [" + StringConverter::toString(leftmost) + ", " +
                 StringConverter::toString(rightmost) + "]  centroid x = " +
                 StringConverter::toString(centroidDen ? double(centroidNum) / double(centroidDen)
                                                       : -1.0));
            // One line per blob: how many, where, and how big. Three records must give
            // three blobs whose pixel counts match one object's.
            {
                size_t x = 0;
                int blobIndex = 0;
                while (x < w) {
                    if (columnCount[x] == 0) { ++x; continue; }
                    const size_t runStart = x;
                    while (x < w && columnCount[x] > 0) ++x;
                    const size_t runEnd = x - 1;
                    size_t ymin = h, ymax = 0, n = 0;
                    long cx = 0, cy = 0;
                    for (size_t yy = 0; yy < h; ++yy) {
                        for (size_t xx = runStart; xx <= runEnd; ++xx) {
                            const int d = std::abs(at(xx, yy, 0) - bg[0]) +
                                          std::abs(at(xx, yy, 1) - bg[1]) +
                                          std::abs(at(xx, yy, 2) - bg[2]);
                            if (d > 30) {
                                if (yy < ymin) ymin = yy;
                                if (yy > ymax) ymax = yy;
                                cx += long(xx); cy += long(yy); ++n;
                            }
                        }
                    }
                    step("blob " + StringConverter::toString(blobIndex) + ": columns [" +
                         StringConverter::toString(runStart) + "," +
                         StringConverter::toString(runEnd) + "] rows [" +
                         StringConverter::toString(ymin) + "," +
                         StringConverter::toString(ymax) + "] pixels " +
                         StringConverter::toString(n) + " centroid (" +
                         StringConverter::toString(n ? double(cx) / double(n) : -1.0) + ", " +
                         StringConverter::toString(n ? double(cy) / double(n) : -1.0) + ")");
                    ++blobIndex;
                }
            }
        }
        window->performManualRelease();
        window->setManualSwapRelease(false);
    }

    step("OK");
    return 0;
}
