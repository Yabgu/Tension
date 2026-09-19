// The no-OGRE backend: the build's renderer when OGRE-Next is not linked.
//
// It exists for two reasons. It keeps the adapter buildable and the session
// contract exercisable on a machine with no OGRE at all — the structural and
// smoke layers of DESIGN.md §14 run anywhere — and it is the shape a real
// backend has to have: start, frame, stop, all on the render thread, all
// reporting through return values and the status mirror.

#include "backend.h"

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
