// The adapter's own state, and the shims the session calls.
//
// One instance, held in a function-local static: the ABI's `ctx` argument is
// whatever the loader passes (null everywhere in this repo), and the design's
// `adapter_ctx` future-work item (DESIGN.md §12) is what would let two
// instances of one adapter coexist in one process. Until then this file says
// so out loud rather than pretending the context pointer is doing work.

#ifndef TENSION_OGRE_ADAPTER_H
#define TENSION_OGRE_ADAPTER_H

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <memory>
#include <mutex>
#include <thread>

#include "tension_adapter.h" // tension-core/include — the ABI header, not ours
#include "backend.h"
#include "config.h"
#include "loader.h"
#include "status.h"

namespace tension_ogre {

struct AdapterState {
    /// The session's API table, valid from `init` to `destroy`.
    const tension_core_api *api = nullptr;
    /// This adapter's event source id, from `register_source` in `link`.
    uint32_t source_id = 0;
    /// The `JOB` region, from `region_lookup` in `link`: the job table's mirror.
    uint32_t job_offset = 0;
    uint32_t job_size = 0;
    /// The three guest-written submission regions, from `region_lookup`.
    uint32_t scene_offset = 0, scene_size = 0;
    uint32_t material_offset = 0, material_size = 0;
    uint32_t renderable_offset = 0, renderable_size = 0;
    /// What the guest has submitted, host-side (the render thread applies it).
    SceneMirror scene;
    /// The `RESOURCE` region, from `region_lookup` in `link`. The renderer's
    /// record lives at `resource_offset + (TENSION_OGRE_RESOURCE_RENDERER - 1)
    /// * TENSION_OGRE_RESOURCE_RECORD_BYTES`.
    uint32_t resource_offset = 0;
    uint32_t resource_size = 0;

    Config config;
    StatusWriter status;
    /// Jobs, bytes and the worker thread. Alive for the adapter's lifetime —
    /// its worker idles on a condition variable when there is no work.
    Loader loader;

    /// Owned by the render thread once it starts; destroyed by that thread
    /// after `stop`. Null whenever no thread is running.
    std::unique_ptr<Backend> backend;
    std::thread thread;
    std::atomic<bool> stop_requested{false};
    std::mutex mutex;
    std::condition_variable cv;
    /// Set by `ogre::init`, cleared when the thread is joined.
    bool initialized = false;
    /// Set while `shutdown` is running, so a concurrent `init` is refused
    /// instead of racing the join.
    bool shutting_down = false;
    /// The render thread's own "I am done" flag; the condvar carries it.
    bool thread_exited = false;

    ~AdapterState() {
        // Last resort. The session calls the vtable's `shutdown` at the end of
        // every run, which joins; if something else tears the library down
        // with a live thread, detaching avoids std::terminate from a joinable
        // thread's destructor.
        if (thread.joinable()) thread.detach();
    }
};

/// The adapter's one instance.
AdapterState &adapter_state();

/// Ask the render thread to stop and wait for it to join, up to `timeout_ms`.
/// Idempotent, and 0 when no thread is running. Returns `-EIO` if the thread
/// did not stop in time, in which case it is detached and left to finish.
int32_t stop_and_join(uint32_t timeout_ms);

} // namespace tension_ogre

#endif // TENSION_OGRE_ADAPTER_H
