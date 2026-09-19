// The loader: jobs, bytes, and the work that must not happen on the render
// thread.
//
// The split this file implements (DESIGN.md §8.1):
//
//   worker thread   resolve paths, read bytes, check magic, report. No OGRE
//                   call, ever — which is what makes "is OGRE thread-safe?"
//                   a question this adapter never has to answer.
//   render thread   `drain_completions` hands the bytes to the backend, which
//                   is where OGRE parses and creates. That thread owns every
//                   OGRE object, so it also owns the transition to DONE.
//   guest thread    `mirror_to_region` runs inside the publish hook, on the
//                   interpreter thread, and is the only path into guest memory.
//
// The job table is the mirror of the JOB region (768 slots × 64 B) plus the
// RESOURCE records those jobs produce. The region is the truth the guest's
// `jobState()` reads; this table is the truth the adapter writes it from.

#ifndef TENSION_OGRE_LOADER_H
#define TENSION_OGRE_LOADER_H

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <functional>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "backend.h"
#include "status.h"

namespace tension_ogre {

/// What the worker found for one job: bytes, or the errno that stopped it.
struct LoadCompletion {
    uint32_t job_id = 0;
    std::vector<uint8_t> bytes;
    int32_t error = 0; ///< 0 on success, else a negative errno
};

/// One job's host-side state, mirroring the 64-byte `Job` record.
///
/// A job's id is its slot index plus one — not a separate counter — because the
/// guest SDK addresses the region that way: `jobRecord(jobId)` is
/// `(jobId - 1) * 64`, so if ids and slots diverged, `jobState()` would read
/// somebody else's record. Releasing a slot frees its id for reuse.
struct JobSlot {
    uint32_t job_id = 0;
    uint32_t state = 0;
    uint32_t kind = 0; ///< TENSION_OGRE_RES_KIND_MESH / _TEXTURE
    uint32_t resource_id = 0;
    int32_t priority = 0;
    float progress = 0.0f;
    int32_t error = 0;
    uint32_t name_offset = 0;
    uint32_t name_length = 0;
    uint64_t seq = 0;
    /// Host-side only: the worker reads this name, the mirror never writes it.
    std::string name;
    bool dirty = false;
    bool in_flight = false;
    bool free = true;
};

/// One resource the adapter has realised, mirroring the 48-byte `Resource`.
struct ResourceSlot {
    uint32_t resource_id = 0;
    uint32_t kind = 0;
    uint32_t state = 0;
    int32_t error = 0;
    uint64_t seq = 0;
    uint32_t name_offset = 0;
    uint32_t name_length = 0;
    ResourceHandle handle = kNoResourceHandle;
    bool dirty = false;
};

/// Everything the loader needs from the world it lives in. The adapter wires
/// these to the session's API in `link`; the unit tests wire them to recorders.
struct LoaderSink {
    std::function<void(uint32_t class_id, uint32_t a, uint32_t b)> post_event;
    std::function<void(int32_t level, const std::string &message)> log;
    /// One line per refusal, so a message names the module (§6.1).
    void note(int32_t level, const std::string &message) const {
        if (log) log(level, message);
    }
};

class Loader {
  public:
    /// The declared capacity: the JOB region is 48 KiB of 64-byte records.
    static constexpr uint32_t kCapacity = 768;

    Loader();
    ~Loader();

    Loader(const Loader &) = delete;
    Loader &operator=(const Loader &) = delete;

    void set_sink(LoaderSink sink);
    /// Where names are looked up, in order. Paths are tried in the order given.
    void set_search_paths(std::vector<std::string> paths);

    // ── the guest-thread face (called from the import shims) ─────────────

    /// Create a job and hand it to the worker. Returns the job id (1-based),
    /// `-ENOSPC` when the table is full, `-EINVAL` for a malformed request.
    int32_t queue(uint32_t kind, const std::string &name, uint32_t name_offset,
                  uint32_t name_length, int32_t priority);

    /// Copy one job's record into `out` (64 bytes). `-ENOENT` for an id that is
    /// not in the table.
    int32_t job_state(uint32_t job_id, uint8_t out[64]) const;

    /// Free a job's slot. The record keeps `JOB_RELEASED`; the slot returns to
    /// the free list and the next job reuses it with a fresh id.
    int32_t job_release(uint32_t job_id);

    // ── the render-thread face ───────────────────────────────────────────

    /// Realise everything the worker finished, on the render thread. Posts
    /// JOB_DONE / JOB_FAILED as it goes.
    void drain_completions(Backend &backend);

    /// Mark every in-flight job FAILED with `error` — the stop() path.
    void sweep_failed(int32_t error);

    // ── the publish face (guest thread, inside an epoch) ─────────────────

    /// Write dirty job records and resource records into the two regions.
    /// Returns the number of bytes written. Clears dirty flags only for what
    /// was written; a refused write leaves the region for the next epoch.
    using GuestWrite = std::function<int32_t(uint32_t ptr, const void *src, uint32_t len)>;
    size_t mirror_to_region(const GuestWrite &write, uint32_t job_region_offset,
                            uint32_t resource_region_offset);

    bool has_dirty() const;

    // ── test hooks ──────────────────────────────────────────────────────

    size_t live_jobs() const;
    size_t free_slots() const;
    /// Wait until the worker has nothing queued and nothing in flight, or the
    /// timeout expires. Returns true when it went idle.
    bool wait_for_idle(uint32_t timeout_ms);
    ResourceSlot resource_at(uint32_t resource_id) const;
    JobSlot job_at(uint32_t slot_index) const;
    /// The slot a job currently occupies, or `kCapacity` when it has none.
    uint32_t slot_of(uint32_t job_id) const;

  private:
    void worker_main();
    void slot_state_for_worker(uint32_t slot_index);
    void fail_slot(uint32_t slot_index, int32_t error, const LoaderSink &sink);
    uint32_t allocate_resource(JobSlot &job, ResourceHandle handle);
    JobSlot *slot_for(uint32_t job_id);
    const JobSlot *slot_for(uint32_t job_id) const;
    size_t in_flight_or_zero() const;
    uint32_t capacity_or_size() const;

    mutable std::mutex mutex_;
    std::condition_variable work_cv_;   ///< worker waits here
    std::condition_variable idle_cv_;   ///< tests wait here
    std::vector<JobSlot> jobs_;
    std::vector<ResourceSlot> resources_; ///< index 0 unused: ids are 1-based
    std::deque<uint32_t> free_slots_; ///< FIFO: slot indices are handed out in order
    std::deque<uint32_t> pending_slots_; ///< slots the worker should load
    std::deque<LoadCompletion> completions_;
    std::vector<std::string> search_paths_;
    LoaderSink sink_;
    uint32_t next_resource_id_ = 1;
    bool stopping_ = false;
    bool worker_busy_ = false; ///< true while the worker is inside a read
    std::thread worker_;
};

} // namespace tension_ogre

#endif // TENSION_OGRE_LOADER_H
