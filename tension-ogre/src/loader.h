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
#include "mounts.h"
#include "status.h"

namespace tension_ogre {

/// What the worker found for one job: bytes, or the errno that stopped it.
struct LoadCompletion {
    uint32_t job_id = 0;
    std::vector<uint8_t> bytes;
    int32_t error = 0; ///< 0 on success, else a negative errno
};

/// One procedural mesh waiting for the render thread: the arrays the guest
/// wrote into `BUFFER_POOL`, its resource id, and the format it declared.
///
/// The id exists before the mesh does — `create_mesh` hands it back to the
/// guest on the guest thread, and only the render thread may make an OGRE
/// object — so a realisation that fails writes the resource record's
/// `state`/`error` instead of returning to a caller that is long gone.
struct ProceduralRequest {
    uint32_t resource_id = 0;
    uint32_t format = 0;
    uint32_t topology = 0;
    std::vector<uint8_t> vertices;
    std::vector<uint8_t> indices;
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
    /// A rigged mesh's bone count, as the backend reported it when it realised
    /// the mesh; 0 for everything else. The guest sees it in the record's `size`
    /// field with bit 0 of `flags` set, and the mirror asks for it here — the
    /// render thread owns the backend, so this is the only copy the guest
    /// thread may read.
    uint32_t bone_count = 0;
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

    void start();
    void stop();
    void stop_detach();

    Loader(const Loader &) = delete;
    Loader &operator=(const Loader &) = delete;

    void set_sink(LoaderSink sink);

    /// Mount a Tension Volume under `prefix` (chunk 11). The loader owns the
    /// bytes and borrows `res` over them (mounts.h). Returns 0, or the errno:
    /// -EINVAL for a bad prefix, -EEXIST for a duplicate. The table is
    /// append-only and never rewritten, which is what makes a resolved
    /// pointer a lifetime decision rather than a race.
    int32_t add_mount(const std::string &prefix, const std::string &tns_path,
                      std::vector<uint8_t> bytes, tension_res *res);

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

    /// Take a mesh the guest built in `BUFFER_POOL` and give it a resource id
    /// now, realising it on the render thread later (chunk 5.5).
    ///
    /// Returns the resource id (1-based), `-EINVAL` for an empty array, or
    /// `-ENOSPC` when the `RESOURCE` region's ceiling is reached. The bytes are
    /// **copied**: the guest's `BUFFER_POOL` is guest memory, and the guest is
    /// free to rewrite it the moment this returns.
    int32_t queue_procedural_mesh(const uint8_t *vertices, size_t vertex_bytes, uint32_t format,
                                 const uint8_t *indices, size_t index_bytes, uint32_t topology);

    // ── the render-thread face ───────────────────────────────────────────

    /// Realise everything the worker finished, on the render thread. Posts
    /// JOB_DONE / JOB_FAILED as it goes.
    void drain_completions(Backend &backend);

    /// Mark every in-flight job FAILED with `error`, nothing else. `stop()`
    /// uses it, and so do the loader's own tests; the render thread's death
    /// wants `stop_draining`, which moves the drain latch in the same lock.
    void sweep_failed(int32_t error);

    /// Set or clear the drain latch on its own: `0` when a render thread is
    /// about to exist again. Non-zero should go through `stop_draining`
    /// instead, which sweeps as it latches.
    void set_drain_state(int32_t error);

    /// The render thread is gone for good: **one** call that fails every
    /// in-flight job with `error` *and* makes every job queued from here on fail
    /// with it, under a single lock. Two calls cannot be split, because a guest
    /// queueing between them would get a job neither path covers — which is the
    /// bug this exists to prevent, and the guest that queues right as the
    /// renderer dies is exactly this race.
    ///
    /// A job reaches a terminal state only through `drain_completions`, which
    /// only the render thread calls. With no drainer, a job left in `PENDING`
    /// makes a guest polling `jobState` (the SDK's `settle` shape) wait on a
    /// thread that has already exited — measured: a renderer that fails to
    /// start leaves the guest, and the executable, stuck. Failing the job on the
    /// spot takes the same shape a real load failure does, so the guest needs
    /// nothing new of it.
    void stop_draining(int32_t error);

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

    /// The bone count the backend reported for `resource_id`, or 0 when the
    /// resource is not a rigged mesh. Safe to call from the guest thread: it
    /// takes the loader's own lock, and the number was recorded at realisation
    /// and never changes for a live resource.
    uint32_t resource_bone_count(uint32_t resource_id) const;
    JobSlot job_at(uint32_t slot_index) const;
    /// The slot a job currently occupies, or `kCapacity` when it has none.
    uint32_t slot_of(uint32_t job_id) const;

  private:
    void worker_main();
    /// The mounts as stable pointers. The caller must hold `mutex_`.
    std::vector<const Mount *> mount_pointers_locked() const;
    /// The backend's asset resolver: a skeleton the render thread's mesh parse
    /// asked for, read through the mount table as a sibling of the mesh the
    /// job named (`resources/models/x.mesh` + `Stickman.skeleton` ->
    /// `resources/models/Stickman.skeleton`). Takes `mutex_` itself, so it is
    /// safe from the render thread; no OGRE object is touched.
    std::vector<uint8_t> read_sibling_asset(const std::string &mesh_path, const std::string &name,
                                           int32_t *error) const;
    void slot_state_for_worker(uint32_t slot_index);
    void fail_slot(uint32_t slot_index, int32_t error, const LoaderSink &sink);
    uint32_t allocate_resource(JobSlot &job, ResourceHandle handle, uint32_t bone_count);
    JobSlot *slot_for(uint32_t job_id);
    const JobSlot *slot_for(uint32_t job_id) const;
    size_t in_flight_or_zero() const;
    uint32_t capacity_or_size() const;
    /// Fail every in-flight slot with `error`. `mutex_` must be held — the
    /// shared body of `sweep_failed` and `stop_draining`, which differ only in
    /// whether the drain latch moves with it.
    void sweep_locked(int32_t error);

    mutable std::mutex mutex_;
    std::condition_variable work_cv_;   ///< worker waits here
    std::condition_variable idle_cv_;   ///< tests wait here
    std::vector<JobSlot> jobs_;
    std::vector<ResourceSlot> resources_; ///< index 0 unused: ids are 1-based
    std::deque<uint32_t> free_slots_; ///< FIFO: slot indices are handed out in order
    std::deque<uint32_t> pending_slots_; ///< slots the worker should load
    std::deque<LoadCompletion> completions_;
    std::deque<ProceduralRequest> procedural_; ///< guest-built meshes, for this thread's next pass
    /// 0 while a drainer may still run; the errno to fail new jobs with when it
    /// is gone (see set_drain_state).
    int32_t drain_error_ = 0;
    MountTable mounts_; ///< appended by the guest thread, read by the worker
    LoaderSink sink_;
    /// Resource ids are 1-based over the RESOURCE region, and **slot 1 belongs
    /// to the renderer**: `TENSION_OGRE_RESOURCE_RENDERER` is 1, and the adapter
    /// writes the renderer's own record there every publish. The loader
    /// therefore starts at 2 — an id of 1 would put the first resource in the
    /// renderer's slot, and the two records would overwrite each other. Nothing
    /// noticed while a resource id was only ever an opaque handle; it surfaced
    /// the moment the guest read a field of a resource's record (chunk 5b's
    /// `isRigged`, whose first read came back saying the rigged mesh was not
    /// rigged, because the record it read was the renderer's).
    uint32_t next_resource_id_ = 2;
    bool stopping_ = false;
    bool worker_busy_ = false; ///< true while the worker is inside a read
    std::thread worker_;
};

} // namespace tension_ogre

#endif // TENSION_OGRE_LOADER_H
