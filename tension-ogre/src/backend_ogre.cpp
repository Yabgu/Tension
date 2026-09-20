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
#include <OgreFrameListener.h>
#include <OgreImage2.h>
#include <OgreMesh.h>
#include <OgreMesh2.h>
#include <OgreMeshManager.h>
#include <OgreMeshManager2.h>
#include <OgreMeshSerializer.h>
#include <OgreArchiveManager.h>
#include <OgreHlmsManager.h>
#include <OgreHlmsDatablock.h>
#include <OgreItem.h>
#include <OgreLight.h>
#include <OgreLogManager.h>
#include <OgreQuaternion.h>
#include <OgreRoot.h>
#include <OgreSceneManager.h>
#include <OgreSceneNode.h>
#include <OgreTextureBox.h>
#include <OgreTextureGpuManager.h>
#include <OgreWindow.h>

#include <Compositor/OgreCompositorManager2.h>
#include <Hlms/Pbs/OgreHlmsPbs.h>
#include <Hlms/Pbs/OgreHlmsPbsDatablock.h>
#include <Hlms/Unlit/OgreHlmsUnlit.h>
#include <Hlms/Unlit/OgreHlmsUnlitDatablock.h>
#include <Compositor/OgreCompositorWorkspace.h>

#include <unistd.h>

#include <atomic>
#include <cerrno>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <mutex>
#include <string>
#include <vector>

#include "../include/tension_ogre.h"

#ifndef TENSION_OGRE_MEDIA_DIR
#define TENSION_OGRE_MEDIA_DIR "/usr/share/OGRE-Next/Media"
#endif

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

class BackendOgre;

/// The frame listener that takes the picture. OGRE-Next downloads a window's
/// pixels through an asynchronous ticket, and `OgreWindow.h` documents two
/// ways to use it; this is the one it recommends as the reliable alternative
/// to the manual swap release:
///
///     To do that use FrameListener::frameRenderingQueued, *but* you still
///     have to call setWantsToDownload(true) and check canDownloadData()
///     returns true.
///
/// `frameRenderingQueued` runs after the compositor has drawn the frame and
/// before the window swaps it away, so the texture being converted is the
/// frame that was just rendered — measured: the manual-release path raced the
/// swap and produced an all-black image about one run in five, and this one
/// does not.
class ScreenshotListener : public Ogre::FrameListener {
  public:
    explicit ScreenshotListener(BackendOgre *owner) : owner_(owner) {}
    bool frameRenderingQueued(const Ogre::FrameEvent &evt) override;

  private:
    BackendOgre *owner_;
};

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
                // A workspace from the first frame, so the window is cleared
                // and lit before the guest has said anything — the placeholder
                // camera stands in until a submitted one replaces it, which is
                // the probe's proven removeWorkspace + addWorkspace pair in
                // `activate_camera`.
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

            // The Hlms: archives (sources + library, with each Hlms's own Any
            // folder — its absence is a shader that fails to compile), then
            // registration. Without this the first frame cannot build a shader.
            {
                const char *media = std::getenv("TENSION_OGRE_MEDIA_DIR");
                const std::string root = media ? std::string(media) : std::string(TENSION_OGRE_MEDIA_DIR);
                Ogre::ArchiveManager &archives = Ogre::ArchiveManager::getSingleton();
                Ogre::Archive *unlit_sources = archives.load(root + "/Hlms/Unlit/GLSL", "FileSystem", true);
                Ogre::Archive *pbs_sources = archives.load(root + "/Hlms/Pbs/GLSL", "FileSystem", true);
                library_.clear();
                library_.push_back(archives.load(root + "/Hlms/Common/GLSL", "FileSystem", true));
                library_.push_back(archives.load(root + "/Hlms/Common/Any", "FileSystem", true));
                library_.push_back(archives.load(root + "/Hlms/Unlit/Any", "FileSystem", true));
                library_.push_back(archives.load(root + "/Hlms/Pbs/Any", "FileSystem", true));
                hlms_unlit_ = new Ogre::HlmsUnlit(unlit_sources, &library_);
                hlms_pbs_ = new Ogre::HlmsPbs(pbs_sources, &library_);
                root_->getHlmsManager()->registerHlms(hlms_unlit_);
                root_->getHlmsManager()->registerHlms(hlms_pbs_);
            }
            // No framebuffer to download under the NULL render system.
            supports_readback_ = !is_null_rs_;
            if (supports_readback_) {
                screenshot_listener_ = std::make_unique<ScreenshotListener>(this);
                root_->addFrameListener(screenshot_listener_.get());
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
            // A screenshot is taken from the frame listener, between the
            // compositor's draw and the swap (see ScreenshotListener).
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
            // The scene goes first: an Item holds its mesh's vertex buffers,
            // so a mesh unloaded under a live item is what "Vertex Buffer has
            // already been destroyed" means (measured, at teardown, before
            // this order was fixed). Then the resources, then the root.
            clear_scene();
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
                if (screenshot_listener_ != nullptr) {
                    root_->removeFrameListener(screenshot_listener_.get());
                }
                root_->shutdown();
                root_.reset();
            }
            screenshot_listener_.reset();
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

    // ── the scene apply path ────────────────────────────────────────────
    //
    // The mirror's dirty lists become OGRE objects here, on the render thread,
    // once per frame before the frame is drawn. tests/probe_scene.cpp is the
    // source of truth for every OGRE call below: createItem + setDatablock +
    // node->attachObject (there is no Item::attachToNode in 3.0), the
    // removeWorkspace/addWorkspace swap for the first camera, and datablocks
    // from the Hlms managers `start` already registered.
    //
    // Order is by dependency: nodes before the cameras and lights that hang
    // from them, materials before the renderables that bind them. Removals and
    // upserts share one pass per kind, because the mirror marks a removed
    // entry dirty with `live == false` rather than keeping a second list.
    //
    // A per-entry failure is logged and the entry skipped: a bad record is not
    // a dead renderer, and the loop keeps drawing. The entry stays live in the
    // mirror, so a later re-submission of the same id is what retries it.
    int32_t apply_submissions(const SceneMirror &mirror) override {
        if (scene_ == nullptr) return 0;
        int32_t refused = 0;
        try {
            refused += apply_nodes(mirror);
            refused += apply_cameras(mirror);
            refused += apply_lights(mirror);
            refused += apply_materials(mirror);
            refused += apply_renderables(mirror);
        } catch (const Ogre::Exception &e) {
            log_line("ogre: apply_submissions: " + e.getFullDescription());
            return -EIO;
        } catch (const std::exception &e) {
            log_line(std::string("ogre: apply_submissions: ") + e.what());
            return -EIO;
        } catch (...) {
            log_line("ogre: apply_submissions: an exception of unknown type escaped");
            return -EIO;
        }
        return refused == 0 ? 0 : -EIO;
    }

    /// Ask for the next frame to be downloaded. The probe proved the sequence
    /// (setWantsToDownload + setManualSwapRelease, then convertFromTexture);
    /// the NULL render system has no framebuffer, and says so rather than
    /// pretending a frame came back.
    int32_t request_readback() override {
        if (!supports_readback_ || is_null_rs_) {
            backend_log("ogre: screenshot refused: the NULL render system has no framebuffer");
            return -ENOSYS;
        }
        // The download itself happens in `capture_if_ready`, on the render
        // thread, at the one moment the window's texture holds the frame that
        // was just drawn.
        window_->setWantsToDownload(true);
        readback_requested_.store(true);
        return 0;
    }

    int32_t readback(uint8_t *out, size_t cap, size_t *out_len) override {
        std::lock_guard<std::mutex> lock(readback_mutex_);
        const size_t count = last_frame_.size();
        const size_t take = out == nullptr ? 0 : std::min(cap, count);
        if (out != nullptr && take > 0) std::memcpy(out, last_frame_.data(), take);
        if (out_len != nullptr) *out_len = out == nullptr ? count : take;
        return static_cast<int32_t>(count);
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

    // ── the scene apply path's helpers, one per kind (DESIGN.md §5.1) ────

    /// The handle behind a guest-visible resource id. The adapter owns both
    /// tables and wires this at link time; a renderable names a resource by
    /// id, and only this backend knows which of its handles that became.
    ResourceHandle resolve(uint32_t resource_id) {
        if (resource_id == 0 || !resource_lookup_) return kNoResourceHandle;
        return resource_lookup_(resource_id);
    }

    Ogre::MeshPtr mesh_for(uint32_t resource_id) {
        const ResourceHandle handle = resolve(resource_id);
        if (handle == kNoResourceHandle || handle > resources_.size()) return Ogre::MeshPtr();
        const ResourceEntry &entry = resources_[handle - 1];
        if (!entry.live || entry.kind != TENSION_OGRE_RES_KIND_MESH) return Ogre::MeshPtr();
        return entry.mesh;
    }

    /// The name of the texture a slot names, or empty when it names nothing
    /// this backend realised. A datablock binds textures by name, so the name
    /// is the whole mapping.
    Ogre::String texture_name_for(uint32_t resource_id) {
        const ResourceHandle handle = resolve(resource_id);
        if (handle == kNoResourceHandle || handle > resources_.size()) return Ogre::String();
        const ResourceEntry &entry = resources_[handle - 1];
        if (!entry.live || entry.kind != TENSION_OGRE_RES_KIND_TEXTURE) return Ogre::String();
        return entry.name;
    }

    void refused_entry(const char *kind, uint32_t id, const std::string &why) {
        log_line(std::string("ogre: ") + kind + " " + std::to_string(id) +
                 " was refused: " + why);
    }

    // ── nodes ────────────────────────────────────────────────────────────

    int32_t apply_nodes(const SceneMirror &mirror) {
        int32_t refused = 0;
        for (uint32_t id : mirror.dirty_nodes()) {
            if (id == 0 || id > kNodeCapacity) continue;
            if (!mirror.node_live(id)) {
                destroy_node(id);
                continue;
            }
            const SceneNodeRecord *record = mirror.node(id);
            if (record == nullptr) continue;
            try {
                Ogre::SceneNode *node = nodes_[id - 1];
                if (node == nullptr) {
                    // The probe's parenting call: a child of the root, so the
                    // node is in the graph. Hierarchy (`parentId`) is not in
                    // 3b — the mirror refuses a non-zero one before this runs.
                    node = scene_->getRootSceneNode(Ogre::SCENE_DYNAMIC)
                               ->createChildSceneNode(Ogre::SCENE_DYNAMIC);
                    nodes_[id - 1] = node;
                }
                node->setPosition(record->px, record->py, record->pz);
                node->setOrientation(
                    Ogre::Quaternion(record->rw, record->rx, record->ry, record->rz));
                node->setScale(record->sx, record->sy, record->sz);
            } catch (const std::exception &e) {
                refused += 1;
                refused_entry("node", id, e.what());
            }
        }
        return refused;
    }

    void destroy_node(uint32_t id) {
        Ogre::SceneNode *node = nodes_[id - 1];
        if (node == nullptr) return;
        // What a node still carries goes before the node does.
        while (node->numAttachedObjects() > 0) node->detachObject(node->getAttachedObject(0));
        scene_->destroySceneNode(node);
        nodes_[id - 1] = nullptr;
    }

    // ── cameras ──────────────────────────────────────────────────────────

    int32_t apply_cameras(const SceneMirror &mirror) {
        int32_t refused = 0;
        for (uint32_t id : mirror.dirty_cameras()) {
            if (id == 0 || id > kCameraCapacity) continue;
            if (!mirror.camera_live(id)) {
                destroy_camera(id);
                continue;
            }
            const CameraRecord *record = mirror.camera(id);
            if (record == nullptr) continue;
            try {
                Ogre::Camera *camera = cameras_[id - 1];
                if (camera == nullptr) {
                    camera = scene_->createCamera("tension-camera-" + std::to_string(id));
                    cameras_[id - 1] = camera;
                }
                camera->setProjectionType(Ogre::PT_PERSPECTIVE);
                if (record->fov_y > 0.0f) camera->setFOVy(Ogre::Radian(record->fov_y));
                if (record->near_clip > 0.0f) camera->setNearClipDistance(record->near_clip);
                if (record->far_clip > 0.0f) camera->setFarClipDistance(record->far_clip);
                // An aspect of zero means "take the window's", which is what
                // the adapter's own placeholder camera does.
                if (record->aspect > 0.0f) {
                    camera->setAutoAspectRatio(false);
                    camera->setAspectRatio(record->aspect);
                } else {
                    camera->setAutoAspectRatio(true);
                }
                camera->setPosition(record->px, record->py, record->pz);
                camera->setOrientation(
                    Ogre::Quaternion(record->rw, record->rx, record->ry, record->rz));
                // The first live camera is the one the workspace renders
                // through; a later one is created and stays off screen (§12's
                // split-screen item is what would change that).
                if (active_camera_ == nullptr || active_camera_ == camera) {
                    activate_camera(camera, id);
                }
            } catch (const std::exception &e) {
                refused += 1;
                refused_entry("camera", id, e.what());
            }
        }
        return refused;
    }

    /// Point the workspace at this camera: the probe's removeWorkspace +
    /// addWorkspace pair, and under the NULL render system only the
    /// bookkeeping, because that start made no workspace to point.
    void activate_camera(Ogre::Camera *camera, uint32_t id) {
        if (active_camera_ == camera) return;
        if (is_null_rs_ || root_ == nullptr || window_ == nullptr) {
            active_camera_ = camera;
            return;
        }
        try {
            Ogre::CompositorManager2 *compositors = root_->getCompositorManager2();
            if (compositors == nullptr) return;
            if (workspace_ != nullptr) {
                compositors->removeWorkspace(workspace_);
                workspace_ = nullptr;
            }
            workspace_ = compositors->addWorkspace(scene_, window_->getTexture(), camera,
                                                   "tension-basic", true);
            active_camera_ = camera;
            log_line("ogre: the workspace now renders through camera " + std::to_string(id));
        } catch (const std::exception &e) {
            refused_entry("camera", id, std::string("the workspace swap reported: ") + e.what());
        }
    }

    void destroy_camera(uint32_t id) {
        Ogre::Camera *camera = cameras_[id - 1];
        if (camera == nullptr) return;
        if (camera == active_camera_) {
            // The workspace must stop pointing at a camera before it dies.
            if (!is_null_rs_ && workspace_ != nullptr && root_ != nullptr) {
                if (Ogre::CompositorManager2 *compositors = root_->getCompositorManager2()) {
                    compositors->removeWorkspace(workspace_);
                }
                workspace_ = nullptr;
            }
            active_camera_ = nullptr;
            dirty_active_camera_ = true;
        }
        scene_->destroyCamera(camera);
        cameras_[id - 1] = nullptr;
    }

    // ── lights ───────────────────────────────────────────────────────────

    int32_t apply_lights(const SceneMirror &mirror) {
        int32_t refused = 0;
        for (uint32_t id : mirror.dirty_lights()) {
            if (id == 0 || id > kLightCapacity) continue;
            if (!mirror.light_live(id)) {
                destroy_light(id);
                continue;
            }
            const LightRecord *record = mirror.light(id);
            if (record == nullptr) continue;
            try {
                Ogre::Light *light = lights_[id - 1];
                if (light == nullptr) {
                    light = scene_->createLight();
                    lights_[id - 1] = light;
                }
                switch (record->kind) {
                    case 0: light->setType(Ogre::Light::LT_DIRECTIONAL); break;
                    case 1: light->setType(Ogre::Light::LT_POINT); break;
                    case 2: light->setType(Ogre::Light::LT_SPOTLIGHT); break;
                    default: break;
                }
                const Ogre::ColourValue colour(record->r, record->g, record->b, record->a);
                light->setDiffuseColour(colour);
                light->setSpecularColour(colour);
                if (record->intensity > 0.0f) light->setPowerScale(record->intensity);
                if (record->kind != 0 && record->range > 0.0f) {
                    light->setAttenuationBasedOnRadius(record->range, 0.01f);
                }
                // A light needs a node for its place in the world; a
                // directional one only for its direction, which is why that
                // is the one thing set on the light rather than the node.
                Ogre::SceneNode *node = light_nodes_[id - 1];
                if (node == nullptr) {
                    node = scene_->getRootSceneNode(Ogre::SCENE_DYNAMIC)
                               ->createChildSceneNode(Ogre::SCENE_DYNAMIC);
                    light_nodes_[id - 1] = node;
                    node->attachObject(light);
                }
                node->setPosition(record->px, record->py, record->pz);
                if (record->kind == 0) {
                    light->setDirection(Ogre::Vector3(record->dx, record->dy, record->dz));
                }
            } catch (const std::exception &e) {
                refused += 1;
                refused_entry("light", id, e.what());
            }
        }
        return refused;
    }

    void destroy_light(uint32_t id) {
        Ogre::Light *light = lights_[id - 1];
        if (light == nullptr) return;
        if (Ogre::SceneNode *node = light_nodes_[id - 1]) {
            node->detachObject(light);
            scene_->destroySceneNode(node);
            light_nodes_[id - 1] = nullptr;
        }
        scene_->destroyLight(light);
        lights_[id - 1] = nullptr;
    }

    // ── materials ────────────────────────────────────────────────────────

    int32_t apply_materials(const SceneMirror &mirror) {
        int32_t refused = 0;
        for (uint32_t id : mirror.dirty_materials()) {
            if (id == 0 || id > kMaterialCapacity) continue;
            if (!mirror.material_live(id)) {
                destroy_material(id);
                continue;
            }
            const MaterialRecord *record = mirror.material(id);
            if (record == nullptr) continue;
            if (record->kind == TENSION_OGRE_MAT_HLMS_CUSTOM) {
                refused += 1;
                refused_entry("material", id, "a custom Hlms is not in this chunk");
                continue;
            }
            try {
                // A datablock belongs to the Hlms that made it, so a record
                // that changes kind is remade rather than reinterpreted.
                if (datablocks_[id - 1] != nullptr && datablock_kinds_[id - 1] != record->kind) {
                    destroy_material(id);
                }
                if (datablocks_[id - 1] == nullptr) {
                    Ogre::Hlms *owner = record->kind == TENSION_OGRE_MAT_HLMS_PBS
                                            ? static_cast<Ogre::Hlms *>(hlms_pbs_)
                                            : static_cast<Ogre::Hlms *>(hlms_unlit_);
                    if (owner == nullptr) {
                        refused += 1;
                        refused_entry("material", id, "the Hlms manager was never registered");
                        continue;
                    }
                    // The probe's exact construction: default macroblock,
                    // blendblock and params, and the datablock named after
                    // the id so removal can find it again.
                    const Ogre::String name = "tension-mat-" + std::to_string(id);
                    Ogre::HlmsMacroblock macroblock;
                    Ogre::HlmsBlendblock blendblock;
                    Ogre::HlmsParamVec params;
                    datablocks_[id - 1] =
                        owner->createDatablock(name, name, macroblock, blendblock, params);
                    datablock_names_[id - 1] = name;
                    datablock_kinds_[id - 1] = record->kind;
                }
                apply_material_values(datablocks_[id - 1], *record);
            } catch (const std::exception &e) {
                refused += 1;
                refused_entry("material", id, e.what());
            }
        }
        return refused;
    }

    /// The values a material record carries. Unlit is the 3b path
    /// (DESIGN.md §5.1): `setUseColour` + `setColour` is the pair the probe
    /// verified, and a texture only when slot 0 names one. PBS is creatable
    /// and unasserted — without a light rig it draws black.
    void apply_material_values(Ogre::HlmsDatablock *datablock, const MaterialRecord &record) {
        const Ogre::ColourValue diffuse(record.dr, record.dg, record.db, record.da);
        if (record.kind == TENSION_OGRE_MAT_HLMS_PBS) {
            // PBS takes linear colours as vectors, and its own defaults stand
            // where the record says nothing.
            auto *pbs = static_cast<Ogre::HlmsPbsDatablock *>(datablock);
            pbs->setDiffuse(Ogre::Vector3(record.dr, record.dg, record.db));
            if (record.roughness > 0.0f) pbs->setRoughness(record.roughness);
            if (record.metalness > 0.0f) pbs->setMetalness(record.metalness);
            if (record.slot0_resource != 0) {
                const Ogre::String texture = texture_name_for(record.slot0_resource);
                if (!texture.empty()) pbs->setTexture(Ogre::PBSM_DIFFUSE, texture);
            }
            return;
        }
        auto *unlit = static_cast<Ogre::HlmsUnlitDatablock *>(datablock);
        unlit->setUseColour(true);
        unlit->setColour(diffuse);
        if (record.slot0_resource != 0) {
            const Ogre::String texture = texture_name_for(record.slot0_resource);
            if (!texture.empty()) unlit->setTexture(0, texture);
        }
    }

    void destroy_material(uint32_t id) {
        Ogre::HlmsDatablock *datablock = datablocks_[id - 1];
        if (datablock == nullptr) return;
        Ogre::Hlms *owner = datablock_kinds_[id - 1] == TENSION_OGRE_MAT_HLMS_PBS
                                ? static_cast<Ogre::Hlms *>(hlms_pbs_)
                                : static_cast<Ogre::Hlms *>(hlms_unlit_);
        if (owner != nullptr && !datablock_names_[id - 1].empty()) {
            owner->destroyDatablock(datablock_names_[id - 1]);
        }
        datablocks_[id - 1] = nullptr;
        datablock_names_[id - 1].clear();
        datablock_kinds_[id - 1] = 0;
    }

    // ── renderables ──────────────────────────────────────────────────────

    int32_t apply_renderables(const SceneMirror &mirror) {
        int32_t refused = 0;
        for (uint32_t id : mirror.dirty_renderables()) {
            if (id == 0 || id > kRenderableCapacity) continue;
            if (!mirror.renderable_live(id)) {
                destroy_renderable(id);
                continue;
            }
            const RenderableRecord *record = mirror.renderable(id);
            if (record == nullptr) continue;
            try {
                Ogre::Item *item = items_[id - 1];
                Ogre::SceneNode *node = renderable_nodes_[id - 1];
                if (item == nullptr) {
                    const Ogre::MeshPtr mesh = mesh_for(record->mesh_resource_id);
                    if (!mesh) {
                        refused += 1;
                        refused_entry("renderable", id,
                                      "mesh resource " + std::to_string(record->mesh_resource_id) +
                                          " is not a realised mesh");
                        continue;
                    }
                    item = scene_->createItem(mesh, Ogre::SCENE_DYNAMIC);
                    items_[id - 1] = item;
                    node = scene_->getRootSceneNode(Ogre::SCENE_DYNAMIC)
                               ->createChildSceneNode(Ogre::SCENE_DYNAMIC);
                    renderable_nodes_[id - 1] = node;
                    node->attachObject(item);
                }
                Ogre::HlmsDatablock *datablock = nullptr;
                if (record->material_id >= 1 && record->material_id <= kMaterialCapacity) {
                    datablock = datablocks_[record->material_id - 1];
                }
                if (datablock == nullptr) {
                    refused += 1;
                    refused_entry("renderable", id,
                                  "material " + std::to_string(record->material_id) +
                                      " has no datablock yet");
                    continue;
                }
                item->setDatablock(datablock);
                node->setPosition(record->px, record->py, record->pz);
                node->setOrientation(
                    Ogre::Quaternion(record->rw, record->rx, record->ry, record->rz));
                node->setScale(record->sx, record->sy, record->sz);
            } catch (const std::exception &e) {
                refused += 1;
                refused_entry("renderable", id, e.what());
            }
        }
        return refused;
    }

    void destroy_renderable(uint32_t id) {
        Ogre::Item *item = items_[id - 1];
        if (item == nullptr) return;
        if (Ogre::SceneNode *node = renderable_nodes_[id - 1]) {
            node->detachObject(item);
            scene_->destroySceneNode(node);
            renderable_nodes_[id - 1] = nullptr;
        }
        scene_->destroyItem(item);
        items_[id - 1] = nullptr;
    }

    // ── the readback ─────────────────────────────────────────────────────

    /// Everything the apply path made, unmade in the order that keeps a
    /// reference from outliving its target: renderables (and their items),
    /// then the lights, the cameras, the nodes and the datablocks.
    void clear_scene() {
        if (scene_ == nullptr) return;
        for (uint32_t id = 1; id <= kRenderableCapacity; ++id) destroy_renderable(id);
        for (uint32_t id = 1; id <= kLightCapacity; ++id) destroy_light(id);
        for (uint32_t id = 1; id <= kCameraCapacity; ++id) destroy_camera(id);
        for (uint32_t id = 1; id <= kNodeCapacity; ++id) destroy_node(id);
        for (uint32_t id = 1; id <= kMaterialCapacity; ++id) destroy_material(id);
        active_camera_ = nullptr;
    }

    /// Take the picture, if one was asked for and the window's download
    /// ticket can be read. Called by the frame listener on the render thread,
    /// after the frame is drawn and before it is swapped away; `true` keeps
    /// rendering, which is always what this returns.
    ///
    /// A ticket that is not ready yet is not an error: the request stays
    /// pending and the next frame tries again. That is why the guest's
    /// probe/consume loop sees -1 for a frame or two before the bytes arrive.
  public:
    bool capture_if_ready() {
        if (!readback_requested_.load()) return true;
        try {
            if (window_ == nullptr) return true;
            if (!window_->canDownloadData()) return true; // not yet: next frame
            Ogre::Image2 frame;
            Ogre::TextureGpu *backbuffer = window_->getTexture();
            frame.convertFromTexture(backbuffer, 0u, backbuffer->getNumMipmaps() - 1u);
            const Ogre::TextureBox box = frame.getData(0);
            const size_t width = box.width, height = box.height, bpp = box.bytesPerPixel;
            {
                std::lock_guard<std::mutex> lock(readback_mutex_);
                last_frame_.assign(width * height * bpp, 0);
                // Row by row: a TextureBox's rows are padded, a frame the guest
                // parses is not.
                for (size_t y = 0; y < height; ++y) {
                    const uint8_t *row =
                        static_cast<const uint8_t *>(box.data) + y * box.bytesPerRow;
                    std::memcpy(last_frame_.data() + y * width * bpp, row, width * bpp);
                }
            }
            readback_requested_.store(false);
            window_->setWantsToDownload(false);
            log_line("ogre: screenshot: " + std::to_string(width) + "x" + std::to_string(height) +
                     " RGBA8 downloaded");
        } catch (const std::exception &e) {
            readback_requested_.store(false);
            log_line(std::string("ogre: screenshot: the download reported: ") + e.what());
        }
        return true;
    }

  private:
    uint32_t renderer_ = TENSION_OGRE_RENDERER_NULL;
    bool is_null_rs_ = true;
    Ogre::Image2 image_;
    StatusWriter *status_for_messages_ = nullptr;

    // The scene, indexed by mirror id - 1.
    std::vector<Ogre::SceneNode *> nodes_ = std::vector<Ogre::SceneNode *>(kNodeCapacity, nullptr);
    std::vector<Ogre::Camera *> cameras_ = std::vector<Ogre::Camera *>(kCameraCapacity, nullptr);
    std::vector<Ogre::Light *> lights_ = std::vector<Ogre::Light *>(kLightCapacity, nullptr);
    std::vector<Ogre::SceneNode *> light_nodes_ =
        std::vector<Ogre::SceneNode *>(kLightCapacity, nullptr);
    std::vector<Ogre::HlmsDatablock *> datablocks_ =
        std::vector<Ogre::HlmsDatablock *>(kMaterialCapacity, nullptr);
    std::vector<Ogre::String> datablock_names_ = std::vector<Ogre::String>(kMaterialCapacity);
    std::vector<uint32_t> datablock_kinds_ = std::vector<uint32_t>(kMaterialCapacity);
    std::vector<Ogre::Item *> items_ = std::vector<Ogre::Item *>(kRenderableCapacity, nullptr);
    std::vector<Ogre::SceneNode *> renderable_nodes_ =
        std::vector<Ogre::SceneNode *>(kRenderableCapacity, nullptr);
    Ogre::HlmsUnlit *hlms_unlit_ = nullptr;
    Ogre::HlmsPbs *hlms_pbs_ = nullptr;
    Ogre::Camera *active_camera_ = nullptr;
    bool dirty_active_camera_ = false;

    /// Screenshot state: one request gives the next frame's pixels, which stay
    /// until the guest has copied them out (probe/consume, like `last_error`).
    /// The flag is written by the guest thread and read by the render thread;
    /// the pixels themselves are copied under `readback_mutex_`.
    std::atomic<bool> readback_requested_{false};
    bool supports_readback_ = false;
    std::vector<uint8_t> last_frame_;
    std::mutex readback_mutex_;
    Ogre::ArchiveVec library_;
    std::vector<ResourceEntry> resources_; ///< index 0 unused: handles are 1-based
    uint32_t next_resource_ = 1;
    Config config_;
    std::string name_;
    std::string plugin_name_;
    std::string render_system_name_;
    std::filesystem::path temp_dir_;

    std::unique_ptr<ScreenshotListener> screenshot_listener_;
    std::unique_ptr<Ogre::Root> root_;
    Ogre::RenderSystem *render_system_ = nullptr;
    Ogre::Window *window_ = nullptr;
    Ogre::SceneManager *scene_ = nullptr;
    Ogre::Camera *camera_ = nullptr;
    Ogre::CompositorWorkspace *workspace_ = nullptr;
};

} // namespace

bool ScreenshotListener::frameRenderingQueued(const Ogre::FrameEvent &) {
    return owner_->capture_if_ready();
}

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
