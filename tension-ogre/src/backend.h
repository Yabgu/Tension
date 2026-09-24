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
#include <functional>
#include <memory>
#include <string>
#include <vector>

#include "config.h"
#include "scene.h"
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

    // ── the asset resolver: a mesh's own parse names its skeleton ───────
    //
    // The loader binds this before realising a *mesh* job, to the directory of
    // the mesh the guest queued. The backend calls it when the mesh parse
    // reports a linked skeleton, so the skeleton's bytes come from the same
    // volume the mesh did (chunk 11). A backend with nothing bound has no
    // skeleton source, and a mesh that links one fails its realisation with
    // the resolver's error, naming the skeleton.
    //
    // The resolver is called on the render thread and must do no OGRE work:
    // it reads bytes (the adapter's implementation takes the loader's lock and
    // a mounted volume's File), nothing more.
    using AssetResolver =
        std::function<std::vector<uint8_t>(const std::string &name, int32_t *error)>;
    virtual void set_asset_resolver(AssetResolver resolver) { (void)resolver; }

    /// The skeleton the loader found *before* the import, read from the mesh's
    /// own directory in the mount table (the sibling convention: a mesh
    /// `.../models/x.mesh` links `x.skeleton`). It has to arrive before the
    /// parse because the v1 importer captures the skeleton resource it finds
    /// at import time — a registration after the fact replaces the resource
    /// the mesh already holds, and the conversion then builds a def with no
    /// bones (measured). Empty bytes clear it.
    virtual void set_skeleton_candidate(const std::string &name, std::vector<uint8_t> bytes) {
        (void)name;
        (void)bytes;
    }

    /// `out_bones` receives the mesh's bone count — 0 for a static mesh, the
    /// rig's size for a rigged one. It is an out-parameter rather than a
    /// separate query because realisation is the moment the answer exists, and
    /// three things need it: the mirror's bone-batch validation, the guest's
    /// `isRigged`, and the backend's own skeleton bookkeeping.
    virtual int32_t realise_mesh(const uint8_t *bytes, size_t len, ResourceHandle *out,
                                 uint32_t *out_bones) = 0;
    /// Realise a mesh from arrays the guest built in `BUFFER_POOL` rather than
    /// from a mesh file's bytes (chunk 5.5): interleaved vertices under
    /// `format`'s element set, then 16-bit indices.
    ///
    /// Same out-parameters, same errno contract and the same thread as
    /// `realise_mesh` — the render thread, from the loader's deferred queue —
    /// because the difference is where the bytes came from, not what has to be
    /// built out of them.
    virtual int32_t realise_mesh_from_arrays(const uint8_t *vertices, size_t vertex_bytes,
                                             uint32_t format, const uint8_t *indices,
                                             size_t index_bytes, uint32_t topology,
                                             ResourceHandle *out, uint32_t *out_bones) = 0;
    virtual int32_t realise_texture(const uint8_t *bytes, size_t len, ResourceHandle *out) = 0;
    /// Apply the guest's scene submissions on this thread: create, update and
    /// destroy the renderer's objects from the mirror's dirty lists. 3b-ii.
    virtual int32_t apply_submissions(const SceneMirror &scene) = 0;

    /// Ask for the next frame to be read back into the backend's own buffer
    /// (one-shot: the next `frame()` does the download). `-ENOSYS` where there
    /// is no framebuffer to read.
    virtual int32_t request_readback() = 0;

    /// The last downloaded frame, tightly packed RGBA8, top-left origin, at
    /// window resolution. Returns the frame's byte count (0 when nothing has
    /// been downloaded yet), or a negative errno.
    ///
    /// `out == nullptr` probes: nothing is copied and `*out_len` gets the
    /// count. Otherwise `min(cap, count)` bytes are copied into `out` and
    /// `*out_len` gets the bytes copied.
    ///
    /// This is a copy, not a borrowed pointer, and deliberately so: the render
    /// thread replaces the frame buffer at swap time, so a guest-held pointer
    /// into it would be a use-after-free. The copy happens under the backend's
    /// own lock.
    virtual int32_t readback(uint8_t *out, size_t cap, size_t *out_len) = 0;

    /// Release a realised resource. Until the guest has a release verb of its
    /// own, this is called at session teardown.
    virtual int32_t discard_resource(ResourceHandle handle) = 0;

    /// The backend's name, for `[tension:ogre]` diagnostics.
    virtual const char *name() const = 0;

    // ── how the scene apply path finds a resource ────────────────────────
    //
    // A guest names resources by the id the RESOURCE region gave it; a backend
    // realises them under a handle of its own choosing. The adapter owns both
    // tables, so it answers, once, at link time.

    using ResourceLookup = std::function<ResourceHandle(uint32_t resource_id)>;
    void set_resource_lookup(ResourceLookup lookup) { resource_lookup_ = std::move(lookup); }

  protected:
    ResourceLookup resource_lookup_;
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
