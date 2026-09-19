// The OGRE-Next backend: the one file in this capability that includes OGRE
// headers, and the only place OGRE objects are made or unmade.
//
// Everything here runs on the render thread, inside the try/catch at the top of
// each entry point (DESIGN.md §8.1). A caught failure never escapes: it becomes
// the status mirror's error, the errno this file returns, and — from the
// adapter, which owns the API table — a DEVICE_LOST event naming the stage.
//
// The stage codes are the contract with the guest: 0 plugin, 1 render system,
// 2 window, 3 initialise, 4 frame, 5 complete (include/tension_ogre.h).

#include "backend.h"

#include <OgreCamera.h>
#include <OgreColourValue.h>
#include <OgreCommon.h>
#include <OgreException.h>
#include <OgreImage2.h>
#include <OgreMesh.h>
#include <OgreMesh2.h>
#include <OgreMeshManager.h>
#include <OgreMeshManager2.h>
#include <OgreMeshSerializer.h>
#include <OgreLogManager.h>
#include <OgreRoot.h>
#include <OgreSceneManager.h>
#include <OgreTextureGpuManager.h>
#include <OgreWindow.h>

#include <Compositor/OgreCompositorManager2.h>
#include <Compositor/OgreCompositorWorkspace.h>

#include <unistd.h>

#include <cerrno>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <string>

#include "../include/tension_ogre.h"

#ifndef TENSION_OGRE_PLUGIN_DIR
// The build bakes this in from pkg-config's `plugindir`. Without it, the
// runtime override is the only way to find plugins.
#define TENSION_OGRE_PLUGIN_DIR ""
#endif

namespace tension_ogre {
namespace {

/// Realised resources live in the default group: nothing is loaded from a
/// resource location (the bytes arrive from the loader), but OGRE's managers
/// key by (name, group) and require one.
constexpr const char *kResourceGroup = "General";

/// Where the render system plugins live: the build's answer, unless the
/// environment disagrees (an install that moved, or a second copy for a test).
std::string plugin_dir() {
    if (const char *from_env = std::getenv("TENSION_OGRE_PLUGIN_DIR")) return from_env;
    return TENSION_OGRE_PLUGIN_DIR;
}

/// The one line the smoke test asserts on, and the only proof-by-log this
/// milestone has that a real window came up.
void log_line(const std::string &message) { backend_log(message); }

class BackendOgre final : public Backend {
  public:
    explicit BackendOgre(uint32_t renderer) : renderer_(renderer) {}

    int32_t start(const Config &config, StatusWriter &status) override {
        config_ = config;
        status_for_messages_ = &status;
        try {
            const bool null_rs = renderer_ == TENSION_OGRE_RENDERER_NULL;
            is_null_rs_ = null_rs;
            plugin_name_ = null_rs ? "RenderSystem_NULL" : "RenderSystem_GL3Plus";
            render_system_name_ =
                null_rs ? "NULL Rendering Subsystem" : "OpenGL 3+ Rendering Subsystem";
            name_ = null_rs ? "ogre-null" : "ogre-gl3plus";

            // ── STAGE_PLUGIN ─────────────────────────────────────────────
            status.set_stage(TENSION_OGRE_STAGE_PLUGIN);
            const std::string dir = plugin_dir();
            // This stage is where a missing display lands too: the GL3+
            // plugin's own GLX initialisation runs while Root's constructor
            // installs it, so "no X display" is a plugin-stage failure here,
            // not a window-stage one (measured; see the round's report).
            if (dir.empty()) {
                return refuse(status, TENSION_OGRE_STAGE_PLUGIN, -EIO,
                              "no plugin directory: the build baked none in and "
                              "TENSION_OGRE_PLUGIN_DIR is unset");
            }
            const std::string library = dir + "/" + plugin_name_ + ".so";
            if (!std::filesystem::exists(library)) {
                return refuse(status, TENSION_OGRE_STAGE_PLUGIN, -EIO,
                              "plugin `" + library + "` is not there");
            }

            // Root's constructor is the only route to PluginFolder in 3.0
            // (`loadPlugins` is protected), so the plugin list is a file this
            // adapter writes — in its own temporary directory, never in the
            // guest's working directory.
            temp_dir_ = std::filesystem::temp_directory_path() /
                        ("tension-ogre-" + std::to_string(static_cast<long>(::getpid())));
            std::filesystem::create_directories(temp_dir_);
            const std::string plugins_cfg = (temp_dir_ / "plugins.cfg").string();
            {
                std::ofstream cfg(plugins_cfg);
                cfg << "PluginFolder=" << dir << "\n";
                cfg << "Plugin=" << plugin_name_ << "\n";
            }
            // OGRE's own log goes to a file, not to stdout: the guest's stdout
            // is the test's evidence, and a thousand lines of startup chatter
            // would make every assertion about it meaningless. The path is
            // reported when something fails, so the detail is still reachable.
            if (Ogre::LogManager::getSingletonPtr() == nullptr) {
                Ogre::LogManager *log_manager = new Ogre::LogManager();
                // defaultLog = true installs it as the singleton's log;
                // debuggerOutput = false keeps OGRE's chatter off stdout, where
                // the guest's own evidence lives.
                log_manager->createLog((temp_dir_ / "Ogre.log").string(), true, false);
            }

            root_ = std::make_unique<Ogre::Root>(nullptr, plugins_cfg,
                                                 (temp_dir_ / "ogre.cfg").string(),
                                                 (temp_dir_ / "Ogre.log").string(), "tension");

            // ── STAGE_RENDER_SYSTEM ──────────────────────────────────────
            status.set_stage(TENSION_OGRE_STAGE_RENDER_SYSTEM);
            render_system_ = root_->getRenderSystemByName(render_system_name_);
            if (render_system_ == nullptr) {
                std::string available;
                for (Ogre::RenderSystem *candidate : root_->getAvailableRenderers()) {
                    if (!available.empty()) available += ", ";
                    available += "'" + candidate->getName() + "'";
                }
                return refuse(status, TENSION_OGRE_STAGE_RENDER_SYSTEM, -EIO,
                              "no render system named '" + render_system_name_ +
                                  "' (this build offers: " + available + ")");
            }
            root_->setRenderSystem(render_system_);

            // These two are conveniences: the window below is sized explicitly,
            // and a render system that does not know an option must not fail
            // the start. Refusing to guess is why the failure is logged rather
            // than thrown — measured on this install, where the option names
            // are not the ones OGRE 1.x used.
            set_option_quietly("Full Screen", "No");
            set_option_quietly("Video Mode", std::to_string(config.window_width) + " x " +
                                                 std::to_string(config.window_height));

            // ── STAGE_WINDOW ─────────────────────────────────────────────
            status.set_stage(TENSION_OGRE_STAGE_WINDOW);
            root_->initialise(false);
            Ogre::NameValuePairList params;
            params["title"] = "Tension";
            params["vsync"] = config.vsync ? "Yes" : "No";
            params["width"] = std::to_string(config.window_width);
            params["height"] = std::to_string(config.window_height);
            window_ = root_->createRenderWindow("Tension", config.window_width,
                                                config.window_height, false, &params);
            if (window_ == nullptr) {
                return refuse(status, TENSION_OGRE_STAGE_WINDOW, -EIO,
                              "createRenderWindow returned null");
            }
            log_line("ogre: window \"Tension\" " + std::to_string(window_->getWidth()) + "x" +
                     std::to_string(window_->getHeight()) + " created (" + render_system_name_ +
                     ")");

            // ── STAGE_INITIALISE ────────────────────────────────────────
            // OGRE-Next has no `addViewport` and no viewport background colour:
            // a window is cleared by a compositor workspace, and the workspace's
            // clear colour *is* the background colour.
            status.set_stage(TENSION_OGRE_STAGE_INITIALISE);
            scene_ = root_->createSceneManager(Ogre::ST_GENERIC, 1u, "tension-scene");
            camera_ = scene_->createCamera("tension-camera");
            camera_->setPosition(0.0f, 0.0f, 10.0f);
            camera_->lookAt(0.0f, 0.0f, 0.0f);
            camera_->setNearClipDistance(0.1f);
            camera_->setAutoAspectRatio(true);

            // The NULL render system is the exception, and it is measured
            // rather than assumed: hanging a workspace over its window
            // segfaults inside OGRE (CompositorPassScene -> getDepthBufferFor
            // -> Window::getDepthBuffer, with both pointers valid when the
            // window is queried directly), and a headless gate has no image to
            // clear. Its frame loop still runs, which is the whole point of it.
            if (renderer_ == TENSION_OGRE_RENDERER_NULL) {
                log_line("ogre: the NULL render system presents nothing; "
                         "running without a compositor workspace");
            } else {
                Ogre::CompositorManager2 *compositors = root_->getCompositorManager2();
                compositors->createBasicWorkspaceDef("tension-basic",
                                                     Ogre::ColourValue(0.1f, 0.1f, 0.1f, 1.0f));
                workspace_ = compositors->addWorkspace(scene_, window_->getTexture(), camera_,
                                                       "tension-basic", true);
                if (workspace_ == nullptr) {
                    return refuse(status, TENSION_OGRE_STAGE_INITIALISE, -EIO,
                                  "the basic workspace was refused");
                }
            }

            // ── STAGE_FRAME: prove the pipeline runs before saying ready ──
            status.set_stage(TENSION_OGRE_STAGE_FRAME);
            if (!root_->renderOneFrame()) {
                return refuse(status, TENSION_OGRE_STAGE_FRAME, -EIO,
                              "the first frame reported the window closed");
            }
            status.note_frame();

            status.set_window(window_->getWidth(), window_->getHeight());
            status.set_stage(TENSION_OGRE_STAGE_COMPLETE);
            status.set_state(TENSION_OGRE_RES_STATE_READY);
            return 0;
        } catch (const Ogre::Exception &e) {
            return refuse(status, status.snapshot().stage, -EIO, e.getFullDescription());
        } catch (const std::exception &e) {
            return refuse(status, status.snapshot().stage, -EIO, e.what());
        } catch (...) {
            return refuse(status, status.snapshot().stage, -EIO,
                          "an exception of unknown type escaped OGRE");
        }
    }

    int32_t frame(StatusWriter &status) override {
        try {
            if (root_ == nullptr || window_ == nullptr) return -EIO;
            if (!root_->renderOneFrame()) {
                // The guest (or the window manager) closed the window: a normal
                // end, not a failure. Positive means "stop", and the adapter
                // stops without faulting the session.
                status.set_state(TENSION_OGRE_RES_STATE_UNLOADED);
                return kBackendStopRequested;
            }
            status.note_frame();
            return 0;
        } catch (const Ogre::Exception &e) {
            return refuse(status, TENSION_OGRE_STAGE_FRAME, -EIO, e.getFullDescription());
        } catch (const std::exception &e) {
            return refuse(status, TENSION_OGRE_STAGE_FRAME, -EIO, e.what());
        } catch (...) {
            return refuse(status, TENSION_OGRE_STAGE_FRAME, -EIO,
                          "an exception of unknown type escaped a frame");
        }
    }

    int32_t stop(StatusWriter &status) override {
        (void)status;
        try {
            // Everything OGRE made is unmade here, on the thread that made it.
            // Resources first: a texture outliving its render system is how a
            // teardown turns into a crash.
            for (ResourceHandle handle = 1; handle <= resources_.size(); ++handle) {
                discard_resource(handle);
            }
            if (root_ != nullptr && window_ != nullptr && render_system_ != nullptr) {
                render_system_->destroyRenderWindow(window_);
            }
            window_ = nullptr;
            workspace_ = nullptr;
            camera_ = nullptr;
            scene_ = nullptr;
            if (root_ != nullptr) {
                root_->shutdown();
                root_.reset();
            }
            render_system_ = nullptr;
            if (!temp_dir_.empty()) {
                std::error_code ignored;
                std::filesystem::remove_all(temp_dir_, ignored);
                temp_dir_.clear();
            }
            return 0;
        } catch (const Ogre::Exception &e) {
            return refuse_final(e.getFullDescription());
        } catch (const std::exception &e) {
            return refuse_final(e.what());
        } catch (...) {
            return refuse_final("an exception of unknown type escaped shutdown");
        }
    }

    const char *name() const override { return name_.empty() ? "ogre" : name_.c_str(); }

    /// One realised resource. Handles are indices into this table, 1-based, so
    /// that 0 stays "no handle".
    struct ResourceEntry {
        uint32_t kind = 0;
        std::string name;
        Ogre::v1::MeshPtr v1_mesh; ///< kept: the Mesh2 reloads from it
        Ogre::MeshPtr mesh;
        Ogre::TextureGpu *texture = nullptr;
        bool live = false;
    };

    int32_t realise_mesh(const uint8_t *bytes, size_t len, ResourceHandle *out) override {
        try {
            const uint32_t handle = next_resource_++;
            const Ogre::String name = "tension-mesh-" + std::to_string(handle);

            // The probe's verified sequence: bytes -> v1 mesh -> Mesh2 -> load.
            // The v1 -> v2 conversion is deferred, so `load()` is what makes
            // the submeshes (and the buffers) real.
            Ogre::DataStreamPtr stream(new Ogre::MemoryDataStream(
                const_cast<uint8_t *>(bytes), len, false, /* readOnly */ true));
            Ogre::v1::MeshPtr v1 =
                Ogre::v1::MeshManager::getSingleton().createManual(name + "-v1", kResourceGroup);
            Ogre::v1::MeshSerializer serializer;
            serializer.importMesh(stream, v1.get());
            Ogre::MeshPtr mesh = Ogre::MeshManager::getSingleton().createByImportingV1(
                name, kResourceGroup, v1.get(), false, false, false);
            mesh->load();

            ResourceEntry entry;
            entry.kind = TENSION_OGRE_RES_KIND_MESH;
            entry.name = name;
            entry.v1_mesh = v1;
            entry.mesh = mesh;
            entry.live = true;
            resources_.push_back(entry);
            *out = handle;
            return 0;
        } catch (const Ogre::Exception &e) {
            return realisation_failed(e.getFullDescription());
        } catch (const std::exception &e) {
            return realisation_failed(e.what());
        } catch (...) {
            return realisation_failed("an exception of unknown type escaped the mesh loader");
        }
    }

    int32_t realise_texture(const uint8_t *bytes, size_t len, ResourceHandle *out) override {
        try {
            const uint32_t handle = next_resource_++;
            const Ogre::String name = "tension-texture-" + std::to_string(handle);

            // Bytes -> Image2 (the codec comes from the file's own magic) ->
            // a texture whose settings come from the image -> resident. The
            // settings are load-bearing: scheduling an image onto a texture
            // whose format and resolution do not match it fails, and that
            // failure is what aborted this process in round 3a-i's probe.
            Ogre::DataStreamPtr stream(new Ogre::MemoryDataStream(
                const_cast<uint8_t *>(bytes), len, false, /* readOnly */ true));
            image_.load(stream);

            Ogre::TextureGpuManager *textures = render_system_->getTextureGpuManager();
            Ogre::TextureGpu *texture = textures->createTexture(
                name, Ogre::GpuPageOutStrategy::Discard, Ogre::TextureFlags::ManualTexture,
                Ogre::TextureTypes::Type2D, kResourceGroup);
            texture->setPixelFormat(image_.getPixelFormat());
            texture->setTextureType(image_.getTextureType());
            texture->setNumMipmaps(image_.getNumMipmaps());
            texture->setResolution(image_.getWidth(), image_.getHeight());
            texture->scheduleTransitionTo(Ogre::GpuResidency::Resident, &image_, false);
            texture->waitForMetadata();

            ResourceEntry entry;
            entry.kind = TENSION_OGRE_RES_KIND_TEXTURE;
            entry.name = name;
            entry.texture = texture;
            entry.live = true;
            resources_.push_back(entry);
            *out = handle;
            return 0;
        } catch (const Ogre::Exception &e) {
            return realisation_failed(e.getFullDescription());
        } catch (const std::exception &e) {
            return realisation_failed(e.what());
        } catch (...) {
            return realisation_failed("an exception of unknown type escaped the texture loader");
        }
    }

    int32_t discard_resource(ResourceHandle handle) override {
        if (handle == kNoResourceHandle || handle > resources_.size()) return -ENOENT;
        ResourceEntry &entry = resources_[handle - 1];
        if (!entry.live) return -ENOENT;
        try {
            if (entry.texture != nullptr) {
                render_system_->getTextureGpuManager()->destroyTexture(entry.texture);
            }
            if (entry.mesh) entry.mesh->unload();
            if (entry.v1_mesh) entry.v1_mesh->unload();
        } catch (const std::exception &e) {
            backend_log(std::string("ogre: discarding a resource reported: ") + e.what());
        }
        entry.live = false;
        entry.texture = nullptr;
        entry.mesh.reset();
        entry.v1_mesh.reset();
        return 0;
    }

  private:
    /// A realisation that failed: the errno fails the job, and the prose goes
    /// to the mirror's message (not its state — a resource that would not load
    /// is not a renderer that died) so `last_error()` can name it.
    int32_t realisation_failed(const std::string &why) {
        const std::string line = "ogre: resource refused: " + why;
        backend_log(line);
        status_for_messages_->note_message(line);
        return -EIO;
    }

    /// Try a render system option, and say so when the option is not there.
    void set_option_quietly(const std::string &option, const std::string &value) {
        try {
            render_system_->setConfigOption(option, value);
        } catch (const Ogre::Exception &e) {
            log_line("ogre: render system has no option `" + option + "` (" +
                     e.getFullDescription() + "); the window's explicit size stands");
        }
    }

    /// Record a failure in the mirror and return its errno. The adapter turns
    /// this into the DEVICE_LOST event — this file has no API table, so it
    /// cannot post one itself, and should not.
    int32_t refuse(StatusWriter &status, uint32_t stage, int32_t error,
                   const std::string &what) {
        const std::string line = "ogre: " + what;
        status.set_error(stage, error, line);
        log_line(line);
        if (!temp_dir_.empty()) {
            log_line("ogre: OGRE's own log is " + (temp_dir_ / "Ogre.log").string());
        }
        return error;
    }

    int32_t refuse_final(const std::string &what) {
        log_line("ogre: teardown reported: " + what);
        return -EIO;
    }

    uint32_t renderer_ = TENSION_OGRE_RENDERER_NULL;
    bool is_null_rs_ = true;
    Ogre::Image2 image_;
    StatusWriter *status_for_messages_ = nullptr;
    std::vector<ResourceEntry> resources_; ///< index 0 unused: handles are 1-based
    uint32_t next_resource_ = 1;
    Config config_;
    std::string name_;
    std::string plugin_name_;
    std::string render_system_name_;
    std::filesystem::path temp_dir_;

    std::unique_ptr<Ogre::Root> root_;
    Ogre::RenderSystem *render_system_ = nullptr;
    Ogre::Window *window_ = nullptr;
    Ogre::SceneManager *scene_ = nullptr;
    Ogre::Camera *camera_ = nullptr;
    Ogre::CompositorWorkspace *workspace_ = nullptr;
};

} // namespace

std::unique_ptr<Backend> make_backend(const Config &config) {
    // The two render systems this build can bring up. Metal and Vulkan are in
    // the SDK's enum but not in this install's plugins, so they are refused by
    // the adapter with -ENOSYS at the plugin stage rather than pretended here.
    if (config.renderer == TENSION_OGRE_RENDERER_NULL ||
        config.renderer == TENSION_OGRE_RENDERER_GL3PLUS) {
        return std::make_unique<BackendOgre>(config.renderer);
    }
    return nullptr;
}

} // namespace tension_ogre
