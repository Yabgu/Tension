// probe_ogre.cpp — not shipped, not part of the adapter.
//
// Answers the questions the chunk-2 plan depends on before any adapter code is
// designed against OGRE-Next 3.0.0:
//
//   1. The exact render system display names, i.e. the strings
//      `Root::getRenderSystemByName` accepts. The plugin binaries contain both
//      spellings ("NULL RenderSystem" and "NULL Rendering Subsystem"), so the
//      probe asks the loaded plugin rather than trusting `strings`.
//   2. Whether the NULL render system creates a window and returns true from
//      `renderOneFrame()` — the headless CI gate. And the same for GL3+.
//   3. How a plugin is found. `Root::loadPlugins` is protected in 3.0, so the
//      folder mechanism is only reachable through the constructor, while
//      `loadPlugin` takes whatever path it is handed. The probe tests both:
//        path — loadPlugin("<folder>/RenderSystem_X", bOptional=false)
//        cfg  — write plugins.cfg with PluginFolder= and Plugin=, then let the
//               Root constructor read it
//
// One render system per process: a second Root in the same process would
// dlopen the same image again and install the same plugin twice.
//
//   g++ -std=c++17 -isystem /usr/include/OGRE-Next probe_ogre.cpp
//       -o probe_ogre -lOgreNextMain -lpthread
//   ./probe_ogre NULL    /usr/lib/OGRE-Next path
//   ./probe_ogre GL3Plus /usr/lib/OGRE-Next cfg
//
// -isystem rather than -I on OGRE's headers: they are not warning-clean, and
// the adapter's build should not turn their warnings into ours.

#include <OgreRoot.h>
#include <OgreRenderSystem.h>
#include <OgreWindow.h>

#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <string>
#include <vector>

namespace {

// The folder is taken verbatim from argv, so a trailing slash can be compared.
void write_plugins_cfg(const std::string &dir, const std::string &plugin_lib, bool with_plugin) {
    std::ofstream cfg("plugins.cfg");
    cfg << "PluginFolder=" << dir << "\n";
    if (with_plugin) cfg << "Plugin=" << plugin_lib << "\n";
}

// Everything after the plugin is loaded is the same whichever path loaded it.
int probe_loaded(Ogre::Root &root, const std::vector<std::string> &names) {
    std::printf("[probe] getAvailableRenderers():\n");
    for (Ogre::RenderSystem *rs : root.getAvailableRenderers())
        std::printf("[probe]   '%s'\n", rs->getName().c_str());

    Ogre::RenderSystem *chosen = nullptr;
    for (const std::string &name : names) {
        Ogre::RenderSystem *rs = root.getRenderSystemByName(name);
        std::printf("[probe] getRenderSystemByName(\"%s\") -> %s\n", name.c_str(),
                    rs ? "FOUND" : "null");
        if (rs && !chosen) chosen = rs;
    }
    if (!chosen) {
        std::printf("[probe] RESULT: no name accepted\n");
        root.shutdown();
        return 2;
    }

    root.setRenderSystem(chosen);
    std::printf("[probe] initialise(autoCreateWindow=false)\n");
    root.initialise(false);

    std::printf("[probe] createRenderWindow(320x240, windowed)\n");
    Ogre::Window *window = root.createRenderWindow("tension-probe", 320, 240, false, nullptr);
    if (!window) {
        std::printf("[probe] RESULT: createRenderWindow returned NULL\n");
        root.shutdown();
        return 3;
    }
    std::printf("[probe] window %ux%u closed=%d\n", window->getWidth(), window->getHeight(),
                static_cast<int>(window->isClosed()));

    bool all_ok = true;
    for (int frame = 0; frame < 3; ++frame) {
        const bool ok = root.renderOneFrame();
        all_ok = all_ok && ok;
        std::printf("[probe] renderOneFrame #%d -> %d\n", frame, static_cast<int>(ok));
    }

    std::printf("[probe] destroyRenderWindow + shutdown\n");
    chosen->destroyRenderWindow(window);
    root.shutdown();
    std::printf("[probe] RESULT: %s\n", all_ok ? "OK (window + 3 frames)" : "frames refused");
    return all_ok ? 0 : 4;
}

int probe(const std::string &plugin, const std::vector<std::string> &names,
          const std::string &folder, const std::string &mode) {
    const std::string plugin_lib = "RenderSystem_" + plugin;

    if (mode == "cfg") {
        write_plugins_cfg(folder, plugin_lib, true);
        std::printf("[probe] Root(pluginFileName=plugins.cfg) with PluginFolder=%s Plugin=%s\n",
                    folder.c_str(), plugin_lib.c_str());
        Ogre::Root root(nullptr, "plugins.cfg", "ogre.cfg", "Ogre.log", "tension-probe");
        return probe_loaded(root, names);
    }

    write_plugins_cfg(folder, plugin_lib, false);
    std::printf("[probe] Root(pluginFileName=plugins.cfg, no Plugin= lines)\n");
    Ogre::Root root(nullptr, "plugins.cfg", "ogre.cfg", "Ogre.log", "tension-probe");
    const std::string full = folder + "/" + plugin_lib;
    std::printf("[probe] loadPlugin(%s, bOptional=false)\n", full.c_str());
    root.loadPlugin(full, false, nullptr);
    return probe_loaded(root, names);
}

} // namespace

int main(int argc, char **argv) {
    if (argc < 4) {
        std::printf("usage: probe_ogre <NULL|GL3Plus> <plugin-dir> <path|cfg>\n");
        return 1;
    }
    const std::string which = argv[1];
    const std::string folder = argv[2];
    const std::string mode = argv[3];

    if (which == "NULL")
        return probe("NULL", {"NULL RenderSystem", "NULL Rendering Subsystem"}, folder, mode);
    if (which == "GL3Plus")
        return probe("GL3Plus",
                     {"GL 3+ RenderSystem", "OpenGL 3+ Rendering Subsystem", "OpenGL 3+ RenderSystem"},
                     folder, mode);
    std::printf("unknown render system %s\n", which.c_str());
    return 1;
}
