// One renderer, behind the interface the adapter's render thread drives.
//
// All three virtuals run on the render thread — the thread that owns every
// renderer object — never on the interpreter thread. The order is fixed:
// `start` once; `frame` until it returns non-zero or a stop is requested; then
// `stop`, and the adapter destroys the backend right after, on that same
// thread. That is what tension_adapter.h's `shutdown` comment means by joining
// a thread on its own terms: a render system is not thread-safe, so the thread
// that made the objects is the thread that unmakes them.
//
// `start` and `frame` report failure by returning a negative errno. They must
// not throw: the render thread catches anyway (DESIGN.md §8.1), but a backend
// that reports through its return value keeps the stage code precise instead
// of collapsing every failure into the catch-all's stage.

#ifndef TENSION_OGRE_BACKEND_H
#define TENSION_OGRE_BACKEND_H

#include <cstdint>
#include <memory>
#include <string>

#include "config.h"
#include "status.h"

namespace tension_ogre {

/// `frame` returned this: the renderer ended normally (the window was closed),
/// as distinct from a negative errno, which is a failure. Positive values are
/// reserved for "stop cleanly", so the adapter can tell the two apart.
constexpr int32_t kBackendStopRequested = 1;

/// One `[tension:session]`-prefixed line, implemented by the adapter, which
/// owns the API table. Backends format diagnostics; they do not own the log.
void backend_log(const std::string &message);

/// A resource the backend has realised, as the loader sees it: an opaque
/// number. The backend keeps the mapping to its own objects (`Ogre::MeshPtr`,
/// `TextureGpu *`), because the guest never dereferences a handle — it passes
/// the *resource id* back in submit verbs and this adapter looks it up.
using ResourceHandle = uint64_t;
constexpr ResourceHandle kNoResourceHandle = 0;

class Backend {
  public:
    virtual ~Backend() = default;

    /// Bring the renderer up, setting the stage as it goes so a failure names
    /// where it happened. Returns 0, or a negative errno.
    virtual int32_t start(const Config &config, StatusWriter &status) = 0;

    /// Render one frame. Called in a loop until it returns non-zero or the
    /// adapter is asked to stop.
    virtual int32_t frame(StatusWriter &status) = 0;

    /// Tear down everything `start` created, on this thread, before it exits.
    virtual int32_t stop(StatusWriter &status) = 0;

    // ── realisation: the render-thread half of a load ────────────────────
    //
    // Called by `Loader::drain_completions`, on the render thread, with bytes
    // the worker read. Parsing and creation are the only OGRE work in the load
    // path, and it happens here so that every OGRE call in this adapter is made
    // by one thread. A negative return fails the job with that errno.

    virtual int32_t realise_mesh(const uint8_t *bytes, size_t len, ResourceHandle *out) = 0;
    virtual int32_t realise_texture(const uint8_t *bytes, size_t len, ResourceHandle *out) = 0;
    /// Release a realised resource. Until the guest has a release verb of its
    /// own, this is called at session teardown.
    virtual int32_t discard_resource(ResourceHandle handle) = 0;

    /// The backend's name, for `[tension:ogre]` diagnostics.
    virtual const char *name() const = 0;
};

/// The backend this build can provide for `config.renderer`, or `nullptr` when
/// it cannot provide one — which the render thread reports as `-ENOSYS` at the
/// plugin stage rather than as a half-started renderer.
///
/// Round 2a has one backend (`backend_none.cpp`, the no-OGRE build); round 2b
/// adds the OGRE one and this factory gains its arm.
std::unique_ptr<Backend> make_backend(const Config &config);

} // namespace tension_ogre

#endif // TENSION_OGRE_BACKEND_H
