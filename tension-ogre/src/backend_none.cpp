// The no-OGRE backend: the build's renderer when OGRE-Next is not linked.
//
// It exists for two reasons. It keeps the adapter buildable and the session
// contract exercisable on a machine with no OGRE at all — the structural and
// smoke layers of DESIGN.md §14 run anywhere — and it is the shape a real
// backend has to have: start, frame, stop, all on the render thread, all
// reporting through return values and the status mirror.

#include "backend.h"

#include <cerrno>

#include "../include/tension_ogre.h"

namespace tension_ogre {
namespace {

class BackendNone final : public Backend {
  public:
    int32_t start(const Config &config, StatusWriter &status) override {
        (void)config; // no window, no frame rate, no renderer to configure
        status.set_window(0, 0);
        status.set_stage(TENSION_OGRE_STAGE_COMPLETE);
        status.set_state(TENSION_OGRE_RES_STATE_READY);
        return 0;
    }

    int32_t frame(StatusWriter &status) override {
        // One frame is one tick: the counter is what tells a guest the loop is
        // alive, which is the only thing this backend can honestly report.
        status.note_frame();
        return 0;
    }

    int32_t stop(StatusWriter &status) override {
        (void)status;
        return 0;
    }

    const char *name() const override { return "none"; }

    int32_t refuse(const char *what) {
        backend_log(std::string("ogre: this build has no OGRE-Next; ") + what + " is not available");
        return -ENOSYS;
    }

    // A build without OGRE can read and validate bytes — the loader does that
    // on its own thread — but it has no render system to create a resource in,
    // so realisation is refused by name rather than pretended.
    int32_t realise_mesh(const uint8_t *, size_t, ResourceHandle *) override {
        return refuse("realise_mesh");
    }
    int32_t realise_texture(const uint8_t *, size_t, ResourceHandle *) override {
        return refuse("realise_texture");
    }
    int32_t discard_resource(ResourceHandle) override { return 0; }

    // The NULL build accepts a scene graph -- there is nothing to draw it with,
    // but the mirror still tracks it -- and cannot read a framebuffer.
    int32_t apply_submissions(const SceneMirror &) override {
        if (!noted_scene_) {
            backend_log("ogre: this build has no OGRE-Next; submitted scenes are tracked, not drawn");
            noted_scene_ = true;
        }
        return 0;
    }
    int32_t screenshot(uint8_t *, size_t, size_t *) override {
        backend_log("ogre: screenshot is not available in a build without OGRE-Next");
        return -ENOSYS;
    }

  private:
    bool noted_scene_ = false;

  public:
};

} // namespace

std::unique_ptr<Backend> make_backend(const Config &config) {
    // A build without OGRE can satisfy `renderer=null` and nothing else: the
    // other renderers *are* OGRE's render systems, and pretending otherwise
    // would move the refusal from the stage that names the plugin to the first
    // frame that fails mysteriously.
    if (config.renderer == TENSION_OGRE_RENDERER_NULL) return std::make_unique<BackendNone>();
    return nullptr;
}

} // namespace tension_ogre
