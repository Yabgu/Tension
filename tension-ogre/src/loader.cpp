// The loader — see loader.h for the thread split this file implements.

#include "loader.h"

#include <algorithm>
#include <chrono>
#include <cerrno>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <iterator>

#include "../include/tension_ogre.h"

namespace tension_ogre {
namespace {

// The record layouts this file serialises, from the catalogue
// (`assembly/ogre/wire.ts`; the layout hash covers them).
constexpr size_t kJobIdOffset = 0;
constexpr size_t kJobStateOffset = 4;
constexpr size_t kJobKindOffset = 8;
constexpr size_t kJobPriorityOffset = 16;
constexpr size_t kJobResourceIdOffset = 20;
constexpr size_t kJobProgressOffset = 24;
constexpr size_t kJobErrorOffset = 28;
constexpr size_t kJobNameOffsetOffset = 32;
constexpr size_t kJobNameLengthOffset = 36;
constexpr size_t kJobSeqOffset = 40;

constexpr size_t kResourceIdOffset = 0;
constexpr size_t kResourceKindOffset = 4;
constexpr size_t kResourceStateOffset = 8;
constexpr size_t kResourceSizeOffset = 16;
constexpr size_t kResourceNameOffsetOffset = 20;
constexpr size_t kResourceNameLengthOffset = 24;
constexpr size_t kResourceErrorOffset = 28;
/// `flags`, at offset 12 — where a rigged mesh says so (bit 0).
constexpr size_t kResourceFlagsOffset = 12;
constexpr size_t kResourceSeqOffset = 40;

void put_u32(uint8_t *at, size_t offset, uint32_t value) {
    at[offset] = static_cast<uint8_t>(value);
    at[offset + 1] = static_cast<uint8_t>(value >> 8);
    at[offset + 2] = static_cast<uint8_t>(value >> 16);
    at[offset + 3] = static_cast<uint8_t>(value >> 24);
}

void put_i32(uint8_t *at, size_t offset, int32_t value) {
    put_u32(at, offset, static_cast<uint32_t>(value));
}

void put_f32(uint8_t *at, size_t offset, float value) {
    uint32_t bits = 0;
    std::memcpy(&bits, &value, sizeof(bits));
    put_u32(at, offset, bits);
}

void put_u64(uint8_t *at, size_t offset, uint64_t value) {
    for (size_t i = 0; i < 8; ++i) at[offset + i] = static_cast<uint8_t>(value >> (8 * i));
}

/// Whether `needle` appears in the first `limit` bytes.
bool contains_near_start(const std::vector<uint8_t> &bytes, const void *needle, size_t needle_len,
                         size_t limit) {
    if (bytes.size() < needle_len) return false;
    const size_t end = std::min(limit, bytes.size() - needle_len);
    for (size_t at = 0; at <= end; ++at) {
        if (std::memcmp(bytes.data() + at, needle, needle_len) == 0) return true;
    }
    return false;
}

/// True when the bytes look like the kind of file the job asked for.
///
/// A *search*, not a prefix test, and the difference is measured: this
/// install's shipped meshes carry two bytes of their own before
/// "[MeshSerializer" (the probe's first print hid them — control characters
/// are invisible in a terminal), and OGRE's parser accepts them. The check is
/// "did the worker read the right kind of thing", so the tag may be where the
/// file puts it; decoding is the render thread's problem either way.
bool magic_ok(uint32_t kind, const std::vector<uint8_t> &bytes) {
    if (bytes.size() < 4) return false;
    if (kind == TENSION_OGRE_RES_KIND_MESH) {
        const char *tag = "[MeshSerializer";
        return contains_near_start(bytes, tag, std::strlen(tag), 512);
    }
    const uint8_t png[4] = {0x89, 'P', 'N', 'G'};
    const char dds[4] = {'D', 'D', 'S', ' '};
    const uint8_t jpeg[3] = {0xFF, 0xD8, 0xFF};
    return contains_near_start(bytes, png, sizeof(png), 64) ||
           contains_near_start(bytes, dds, sizeof(dds), 64) ||
           contains_near_start(bytes, jpeg, sizeof(jpeg), 64);
}

/// Read a whole file. `-ENOENT` when it is not there, `-EIO` when it is there
/// and unreadable.
/// (Chunk 11 removed the disk read this used to be: the worker's bytes come
/// from the mount table now, through `mount_read` — see mounts.{h,cpp}.)

/// The mount table's snapshot and a sibling asset read live on the Loader; see
/// loader.h for why the worker holds stable `const Mount *` pointers rather
/// than a copy of the table.

} // namespace

Loader::Loader() : jobs_(kCapacity) {
    for (uint32_t index = 0; index < kCapacity; ++index) free_slots_.push_back(index);
    worker_ = std::thread([this] { worker_main(); });
}

Loader::~Loader() {
    {
        std::lock_guard<std::mutex> lock(mutex_);
        stopping_ = true;
    }
    work_cv_.notify_all();
    if (worker_.joinable()) worker_.join();
}

void Loader::set_sink(LoaderSink sink) {
    std::lock_guard<std::mutex> lock(mutex_);
    sink_ = std::move(sink);
}

void Loader::set_search_paths(std::vector<std::string> paths) {
    std::lock_guard<std::mutex> lock(mutex_);
    search_paths_ = std::move(paths);
}

int32_t Loader::add_mount(const std::string &prefix, const std::string &tns_path,
                          std::vector<uint8_t> bytes, tension_res *res) {
    std::lock_guard<std::mutex> lock(mutex_);
    const int32_t refusal = mount_refusal(mounts_, prefix, tns_path);
    if (refusal != 0) return refusal;
    std::unique_ptr<Mount> mount = std::make_unique<Mount>();
    mount->prefix = prefix;
    mount->tns_path = tns_path;
    mount->bytes = std::move(bytes);
    mount->res = res;
    mounts_.push_back(std::move(mount));
    return 0;
}

std::vector<const Mount *> Loader::mount_pointers_locked() const {
    return mount_pointers(mounts_);
}

std::vector<uint8_t> Loader::read_sibling_asset(const std::string &mesh_path,
                                                const std::string &name,
                                                int32_t *error) const {
    int32_t local_error = 0;
    int32_t *slot = error != nullptr ? error : &local_error;
    const size_t slash = mesh_path.find_last_of('/');
    const std::string sibling =
        slash == std::string::npos ? name : mesh_path.substr(0, slash + 1) + name;

    std::vector<const Mount *> mounts;
    LoaderSink sink;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        mounts = mount_pointers_locked();
        sink = sink_;
    }
    std::string relative;
    const Mount *mount = mount_resolve(mounts, sibling, &relative);
    if (mount == nullptr) {
        *slot = -ENOENT;
        // Absence is not an error: the caller's probe invents this candidate
        // from the mesh's own stem, and an unrigged mesh has no sibling (the
        // call site says so). -ENOENT is this branch's only outcome, so the
        // guarded note below cannot fire today; it keeps its place for a
        // genuine refusal. The true "mesh links a skeleton no mount carries"
        // case is reported by the backend (level 1) and fails the job through
        // `fail_slot`, so silence here loses no evidence.
        if (*slot != -ENOENT) {
            sink.note(3, "ogre: mesh " + mesh_path + " links \"" + name +
                         "\" and no mount carries " + sibling);
        }
        return {};
    }
    std::vector<uint8_t> bytes = mount_read(*mount, relative, slot);
    // The same rule: absence is the unrigged case, not a failure — a genuine
    // read failure (a corrupt entry, a short read) still speaks.
    if (*slot != 0 && *slot != -ENOENT) {
        sink.note(3, "ogre: skeleton " + sibling + " could not be read (" +
                         std::to_string(*slot) + ")");
    }
    return bytes;
}

int32_t Loader::queue(uint32_t kind, const std::string &name, uint32_t name_offset,
                      uint32_t name_length, int32_t priority) {
    if (name.empty() || name.size() > 4096) return -EINVAL;
    if (kind != TENSION_OGRE_RES_KIND_MESH && kind != TENSION_OGRE_RES_KIND_TEXTURE) {
        return -EINVAL;
    }

    std::lock_guard<std::mutex> lock(mutex_);
    if (free_slots_.empty()) {
        sink_.note(3, "ogre: no free job slot: release a finished job and retry");
        return -ENOSPC;
    }

    const uint32_t index = free_slots_.front();
    free_slots_.pop_front();

    JobSlot &slot = jobs_[index];
    slot = JobSlot{};
    slot.free = false;
    slot.in_flight = true;
    slot.dirty = true;
    slot.job_id = index + 1; // the id *is* the slot: see loader.h
    slot.state = TENSION_OGRE_JOB_PENDING;
    slot.kind = kind;
    slot.priority = priority;
    slot.name = name;
    slot.name_offset = name_offset;
    slot.name_length = name_length;

    pending_slots_.push_back(index);
    work_cv_.notify_one();
    return static_cast<int32_t>(slot.job_id);
}

int32_t Loader::job_state(uint32_t job_id, uint8_t out[TENSION_OGRE_JOB_RECORD_BYTES]) const {
    std::lock_guard<std::mutex> lock(mutex_);
    const JobSlot *slot = slot_for(job_id);
    if (slot == nullptr) return -ENOENT;
    std::memset(out, 0, TENSION_OGRE_JOB_RECORD_BYTES);
    put_u32(out, kJobIdOffset, slot->job_id);
    put_u32(out, kJobStateOffset, slot->state);
    put_u32(out, kJobKindOffset, slot->kind);
    put_i32(out, kJobPriorityOffset, slot->priority);
    put_u32(out, kJobResourceIdOffset, slot->resource_id);
    put_f32(out, kJobProgressOffset, slot->progress);
    put_i32(out, kJobErrorOffset, slot->error);
    put_u32(out, kJobNameOffsetOffset, slot->name_offset);
    put_u32(out, kJobNameLengthOffset, slot->name_length);
    put_u64(out, kJobSeqOffset, slot->seq);
    return 0;
}

int32_t Loader::job_release(uint32_t job_id) {
    std::lock_guard<std::mutex> lock(mutex_);
    for (uint32_t index = 0; index < capacity_or_size(); ++index) {
        JobSlot &slot = jobs_[index];
        if (slot.free || slot.job_id != job_id) continue;
        // The record keeps the released marker: the guest reads it, and a
        // stale id can be told apart from a live one by the id it now holds.
        slot.state = TENSION_OGRE_JOB_RELEASED;
        slot.dirty = true;
        slot.free = true;
        slot.in_flight = false;
        // To the front: the brief's contract is that the next queue lands in
        // the slot just released, which also keeps a tight load/release loop
        // from walking the whole table.
        free_slots_.push_front(index);
        idle_cv_.notify_all();
        return 0;
    }
    return -ENOENT;
}

int32_t Loader::queue_procedural_mesh(const uint8_t *vertices, size_t vertex_bytes, uint32_t format,
                                     const uint8_t *indices, size_t index_bytes,
                                     uint32_t topology) {
    if (vertices == nullptr || vertex_bytes == 0 || indices == nullptr || index_bytes == 0) {
        return -EINVAL;
    }
    std::lock_guard<std::mutex> lock(mutex_);
    if (next_resource_id_ > 1024) return -ENOSPC; // the RESOURCE region's ceiling

    ProceduralRequest request;
    request.resource_id = next_resource_id_++;
    request.format = format;
    request.topology = topology;
    request.vertices.assign(vertices, vertices + vertex_bytes);
    request.indices.assign(indices, indices + index_bytes);

    ResourceSlot slot;
    slot.resource_id = request.resource_id;
    slot.kind = TENSION_OGRE_RES_KIND_MESH;
    // In flight from here until the render thread realises it. Publishing that
    // state is the honest answer to "what is this id?" — the same one the job
    // table gives for a load that is still running.
    slot.state = TENSION_OGRE_RES_STATE_LOADING;
    slot.dirty = true;
    if (resources_.size() <= slot.resource_id) resources_.resize(slot.resource_id + 1);
    resources_[slot.resource_id] = slot;

    const uint32_t resource_id = request.resource_id;
    procedural_.push_back(std::move(request));
    return static_cast<int32_t>(resource_id);
}

void Loader::drain_completions(Backend &backend) {
    std::deque<LoadCompletion> drained;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        drained.swap(completions_);
    }

    for (LoadCompletion &completion : drained) {
        uint32_t index = 0;
        JobSlot snapshot;
        {
            std::lock_guard<std::mutex> lock(mutex_);
            JobSlot *slot = slot_for(completion.job_id);
            // Released (or gone) while the worker was reading: the completion
            // is history, and a slot that has since been reused belongs to
            // somebody else.
            if (slot == nullptr) continue;
            index = static_cast<uint32_t>(slot - jobs_.data());
            slot->in_flight = false;
            snapshot = *slot;
        }

        LoaderSink sink;
        {
            std::lock_guard<std::mutex> lock(mutex_);
            sink = sink_;
        }

        if (completion.error != 0) {
            fail_slot(index, completion.error, sink);
            continue;
        }

        ResourceHandle handle = kNoResourceHandle;
        uint32_t bones = 0;
        const bool mesh = snapshot.kind == TENSION_OGRE_RES_KIND_MESH;
        if (mesh) {
            // A mesh's skeleton is named inside the mesh file, and only OGRE's
            // parse can say what that name is — the shipped v1 meshes are
            // binary, so there is no tag for the worker to scan. The backend
            // asks back for the skeleton through this resolver while it has
            // the mesh's bytes in hand; the bytes come from the mount table
            // through the same lock the worker uses, and no OGRE object is
            // touched by the read. Binding it to the job's own path is what
            // makes the lookup a *sibling* of the mesh.
            const std::string mesh_path = snapshot.name;
            backend.set_asset_resolver([this, mesh_path](const std::string &name, int32_t *error) {
                return read_sibling_asset(mesh_path, name, error);
            });
            // The sibling convention, applied before the parse: a mesh
            // `resources/models/x.mesh` in a volume links `x.skeleton` beside
            // it, and the v1 importer captures whatever skeleton resource it
            // finds *at import time* — so the candidate has to be registered
            // before `realise_mesh` runs, not after. Absent is not an error: an
            // unrigged mesh has no sibling.
            const size_t dot = mesh_path.find_last_of('.');
            const size_t slash = mesh_path.find_last_of('/');
            if (dot != std::string::npos && (slash == std::string::npos || dot > slash)) {
                const std::string stem = mesh_path.substr(0, dot);
                const std::string candidate = stem.substr(stem.find_last_of('/') + 1) + ".skeleton";
                int32_t sibling_error = 0;
                std::vector<uint8_t> candidate_bytes =
                    read_sibling_asset(mesh_path, candidate, &sibling_error);
                if (sibling_error == 0 && !candidate_bytes.empty()) {
                    backend.set_skeleton_candidate(candidate, std::move(candidate_bytes));
                } else {
                    backend.set_skeleton_candidate("", {});
                }
            } else {
                backend.set_skeleton_candidate("", {});
            }
        }
        const int32_t realised =
            mesh ? backend.realise_mesh(completion.bytes.data(), completion.bytes.size(), &handle,
                                        &bones)
                 : backend.realise_texture(completion.bytes.data(), completion.bytes.size(), &handle);
        if (realised != 0 || handle == kNoResourceHandle) {
            fail_slot(index, realised != 0 ? realised : -EIO, sink);
            continue;
        }

        uint32_t resource_id = 0;
        uint32_t job_id = 0;
        bool table_full = false;
        {
            std::lock_guard<std::mutex> lock(mutex_);
            JobSlot *slot = slot_for(completion.job_id);
            if (slot == nullptr) {
                // Released in the meantime: the resource it produced has no
                // owner left. Discarded below, outside the lock.
                table_full = true;
            } else {
                resource_id = allocate_resource(*slot, handle, bones);
                job_id = slot->job_id;
                if (resource_id == 0) {
                    // The RESOURCE table is full: the job fails rather than
                    // producing an id nobody can read.
                    slot->state = TENSION_OGRE_JOB_FAILED;
                    slot->error = -ENOSPC;
                    slot->dirty = true;
                    table_full = true;
                } else {
                    slot->state = TENSION_OGRE_JOB_DONE;
                    slot->progress = 1.0f;
                    slot->resource_id = resource_id;
                    slot->dirty = true;
                }
            }
        }
        if (table_full) {
            backend.discard_resource(handle);
            if (job_id != 0 && sink.post_event) {
                sink.post_event(TENSION_OGRE_CLASS_JOB_FAILED, job_id,
                                static_cast<uint32_t>(-ENOSPC));
            }
            continue;
        }
        if (sink.post_event) sink.post_event(TENSION_OGRE_CLASS_JOB_DONE, job_id, resource_id);
    }

    // ── the procedural meshes ──────────────────────────────────────────
    //
    // Same thread, same reason: the guest wrote the bytes and already holds the
    // id, so this is where the OGRE object gets made. A failure lands in the
    // resource record, because the call that could have reported it returned
    // before the render thread ran — and the region is where a guest looks for
    // resource outcomes anyway.
    std::deque<ProceduralRequest> procedures;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        procedures.swap(procedural_);
    }
    for (ProceduralRequest &request : procedures) {
        ResourceHandle handle = kNoResourceHandle;
        uint32_t bones = 0;
        const int32_t realised = backend.realise_mesh_from_arrays(
            request.vertices.data(), request.vertices.size(), request.format,
            request.indices.data(), request.indices.size(), request.topology, &handle, &bones);
        std::lock_guard<std::mutex> lock(mutex_);
        if (request.resource_id >= resources_.size()) continue;
        ResourceSlot &slot = resources_[request.resource_id];
        if (realised != 0 || handle == kNoResourceHandle) {
            slot.state = TENSION_OGRE_RES_STATE_FAILED;
            slot.error = realised != 0 ? realised : -EIO;
            slot.dirty = true;
            if (sink_.log) {
                sink_.log(3, "ogre: procedural mesh resource " +
                                 std::to_string(request.resource_id) +
                                 " failed to realise (errno " + std::to_string(slot.error) + ")");
            }
            continue;
        }
        slot.handle = handle;
        slot.state = TENSION_OGRE_RES_STATE_READY;
        slot.bone_count = bones;
        slot.dirty = true;
        if (sink_.log) {
            sink_.log(1, "ogre: procedural mesh resource " + std::to_string(request.resource_id) +
                             " ready (" + std::to_string(request.vertices.size()) +
                             " vertex bytes, " + std::to_string(request.indices.size()) +
                             " index bytes)");
        }
    }

    {
        std::lock_guard<std::mutex> lock(mutex_);
        if (pending_slots_.empty() && completions_.empty() && in_flight_or_zero() == 0) {
            idle_cv_.notify_all();
        }
    }
}

void Loader::sweep_failed(int32_t error) {
    std::lock_guard<std::mutex> lock(mutex_);
    for (JobSlot &slot : jobs_) {
        if (slot.free || !slot.in_flight) continue;
        slot.in_flight = false;
        slot.state = TENSION_OGRE_JOB_FAILED;
        slot.error = error;
        slot.dirty = true;
        // Best effort, and said so: the session may already be closing, in
        // which case this delivery never happens and the region mirror (which
        // publish writes while the session lives) is the record.
        if (sink_.post_event) {
            sink_.post_event(TENSION_OGRE_CLASS_JOB_FAILED, slot.job_id,
                             static_cast<uint32_t>(error));
        }
    }
    idle_cv_.notify_all();
}

size_t Loader::mirror_to_region(const GuestWrite &write, uint32_t job_region_offset,
                                uint32_t resource_region_offset) {
    size_t written = 0;
    std::lock_guard<std::mutex> lock(mutex_);

    for (uint32_t index = 0; index < capacity_or_size(); ++index) {
        JobSlot &slot = jobs_[index];
        if (!slot.dirty) continue;

        uint8_t record[TENSION_OGRE_JOB_RECORD_BYTES] = {};
        put_u32(record, kJobIdOffset, slot.job_id);
        put_u32(record, kJobStateOffset, slot.state);
        put_u32(record, kJobKindOffset, slot.kind);
        put_i32(record, kJobPriorityOffset, slot.priority);
        put_u32(record, kJobResourceIdOffset, slot.resource_id);
        put_f32(record, kJobProgressOffset, slot.progress);
        put_i32(record, kJobErrorOffset, slot.error);
        put_u32(record, kJobNameOffsetOffset, slot.name_offset);
        put_u32(record, kJobNameLengthOffset, slot.name_length);
        put_u64(record, kJobSeqOffset, slot.seq);

        const uint32_t at = job_region_offset + index * TENSION_OGRE_JOB_RECORD_BYTES;
        if (write(at, record, TENSION_OGRE_JOB_RECORD_BYTES) != 0) return written;
        slot.dirty = false;
        written += TENSION_OGRE_JOB_RECORD_BYTES;
    }

    for (uint32_t index = 1; index < resources_.size(); ++index) {
        ResourceSlot &resource = resources_[index];
        if (!resource.dirty) continue;
        uint8_t record[TENSION_OGRE_RESOURCE_RECORD_BYTES] = {};
        put_u32(record, kResourceIdOffset, resource.resource_id);
        put_u32(record, kResourceKindOffset, resource.kind);
        put_u32(record, kResourceStateOffset, resource.state);
        put_i32(record, kResourceErrorOffset, resource.error);
        // A rigged mesh puts its bone count in `size` and says so in `flags`:
        // this is the record the guest reads to decide whether a mesh can be
        // posed at all, and the two fields were both unwritten before it.
        put_u32(record, kResourceFlagsOffset, resource.bone_count > 0 ? 1u : 0u);
        put_u32(record, kResourceSizeOffset, resource.bone_count);
        put_u32(record, kResourceNameOffsetOffset, resource.name_offset);
        put_u32(record, kResourceNameLengthOffset, resource.name_length);
        put_u64(record, kResourceSeqOffset, resource.seq);

        const uint32_t at = resource_region_offset + (resource.resource_id - 1) *
                                                         TENSION_OGRE_RESOURCE_RECORD_BYTES;
        if (write(at, record, TENSION_OGRE_RESOURCE_RECORD_BYTES) != 0) return written;
        resource.dirty = false;
        written += TENSION_OGRE_RESOURCE_RECORD_BYTES;
    }
    return written;
}

bool Loader::has_dirty() const {
    std::lock_guard<std::mutex> lock(mutex_);
    for (const JobSlot &slot : jobs_) {
        if (slot.dirty) return true;
    }
    for (uint32_t index = 1; index < resources_.size(); ++index) {
        if (resources_[index].dirty) return true;
    }
    return false;
}

size_t Loader::live_jobs() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return kCapacity - free_slots_.size();
}

size_t Loader::free_slots() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return free_slots_.size();
}

bool Loader::wait_for_idle(uint32_t timeout_ms) {
    std::unique_lock<std::mutex> lock(mutex_);
    // "Idle" means the worker has nothing queued and is not mid-read. Whether
    // the completions have been drained is the *render* thread's business, so
    // it is deliberately not part of this condition.
    return idle_cv_.wait_for(lock, std::chrono::milliseconds(timeout_ms),
                             [this] { return pending_slots_.empty() && !worker_busy_; });
}

ResourceSlot Loader::resource_at(uint32_t resource_id) const {
    std::lock_guard<std::mutex> lock(mutex_);
    if (resource_id == 0 || resource_id >= resources_.size()) return ResourceSlot{};
    return resources_[resource_id];
}

uint32_t Loader::resource_bone_count(uint32_t resource_id) const {
    std::lock_guard<std::mutex> lock(mutex_);
    if (resource_id == 0 || resource_id >= resources_.size()) return 0;
    return resources_[resource_id].bone_count;
}

uint32_t Loader::slot_of(uint32_t job_id) const {
    std::lock_guard<std::mutex> lock(mutex_);
    const JobSlot *slot = slot_for(job_id);
    if (slot == nullptr) return kCapacity;
    return static_cast<uint32_t>(slot - jobs_.data());
}

JobSlot Loader::job_at(uint32_t slot_index) const {
    std::lock_guard<std::mutex> lock(mutex_);
    if (slot_index >= jobs_.size()) return JobSlot{};
    return jobs_[slot_index];
}

// ── internals ────────────────────────────────────────────────────────────

void Loader::worker_main() {
    for (;;) {
        uint32_t index = 0;
        uint32_t kind_for_worker = TENSION_OGRE_RES_KIND_MESH;
        std::string name;
        std::vector<const Mount *> mounts;
        LoaderSink sink;
        {
            std::unique_lock<std::mutex> lock(mutex_);
            work_cv_.wait(lock, [this] { return stopping_ || !pending_slots_.empty(); });
            if (stopping_) return;
            index = pending_slots_.front();
            pending_slots_.pop_front();
            // Released while queued? Then there is nothing to load, and the
            // slot may already belong to somebody else.
            if (jobs_[index].free || jobs_[index].state != TENSION_OGRE_JOB_PENDING) {
                idle_cv_.notify_all();
                continue;
            }

            name = jobs_[index].name;
            kind_for_worker = jobs_[index].kind;
            slot_state_for_worker(index);
            mounts = mount_pointers_locked();
            sink = sink_;
            worker_busy_ = true;
        }

        int32_t error = -ENOENT;
        std::vector<uint8_t> bytes;
        {
            std::string relative;
            const Mount *mount = mount_resolve(mounts, name, &relative);
            if (mount == nullptr) {
                // The mount table is the only byte source (11a's decision: no
                // fallback to the disk the media tree used to be read from).
                // A path that spells a directory gets the refusal that says
                // so; everything else is "no mount carries this".
                if (mount_path_is_directory(name)) {
                    error = -EINVAL;
                    sink.note(3, "ogre: " + name + " names a directory, not a file");
                } else {
                    error = -ENOENT;
                    sink.note(3, "ogre: no mount for " + name);
                }
            } else {
                bytes = mount_read(*mount, relative, &error);
                if (error != 0) {
                    sink.note(3, "ogre: " + name + " is not in mount \"" + mount->prefix +
                                     "\" (" + std::to_string(error) + ")");
                }
            }
        }
        if (error == 0 && !magic_ok(kind_for_worker, bytes)) error = -EIO;

        {
            std::lock_guard<std::mutex> lock(mutex_);
            std::string head;
            for (size_t i = 0; i < 16 && i < bytes.size(); ++i) head.push_back(
                (bytes[i] >= 32 && bytes[i] < 127) ? static_cast<char>(bytes[i]) : '.');
            LoadCompletion completion;
            completion.job_id = jobs_[index].job_id;
            completion.bytes = std::move(bytes);
            completion.error = error;
            completions_.push_back(std::move(completion));
            worker_busy_ = false;
            idle_cv_.notify_all();
        }
    }
}

void Loader::slot_state_for_worker(uint32_t index) {
    JobSlot &slot = jobs_[index];
    slot.state = TENSION_OGRE_JOB_LOADING;
    slot.dirty = true;
}

void Loader::fail_slot(uint32_t index, int32_t error, const LoaderSink &sink) {
    std::lock_guard<std::mutex> lock(mutex_);
    JobSlot &slot = jobs_[index];
    slot.state = TENSION_OGRE_JOB_FAILED;
    slot.error = error;
    slot.in_flight = false;
    slot.dirty = true;
    if (sink.post_event) {
        sink.post_event(TENSION_OGRE_CLASS_JOB_FAILED, slot.job_id, static_cast<uint32_t>(error));
    }
}

uint32_t Loader::allocate_resource(JobSlot &job, ResourceHandle handle, uint32_t bone_count) {
    if (next_resource_id_ > 1024) return 0; // the RESOURCE region's ceiling
    ResourceSlot resource;
    resource.resource_id = next_resource_id_++;
    resource.kind = job.kind;
    resource.state = TENSION_OGRE_RES_STATE_READY;
    resource.handle = handle;
    resource.bone_count = bone_count;
    resource.name_offset = job.name_offset;
    resource.name_length = job.name_length;
    resource.dirty = true;
    if (resources_.size() <= resource.resource_id) resources_.resize(resource.resource_id + 1);
    resources_[resource.resource_id] = resource;
    return resource.resource_id;
}

JobSlot *Loader::slot_for(uint32_t job_id) {
    if (job_id == 0) return nullptr;
    for (JobSlot &slot : jobs_) {
        if (!slot.free && slot.job_id == job_id) return &slot;
    }
    return nullptr;
}

const JobSlot *Loader::slot_for(uint32_t job_id) const {
    if (job_id == 0) return nullptr;
    for (const JobSlot &slot : jobs_) {
        if (!slot.free && slot.job_id == job_id) return &slot;
    }
    return nullptr;
}

size_t Loader::in_flight_or_zero() const {
    size_t in_flight = 0;
    for (const JobSlot &slot : jobs_) {
        if (!slot.free && slot.in_flight) in_flight += 1;
    }
    return in_flight;
}

uint32_t Loader::capacity_or_size() const { return static_cast<uint32_t>(jobs_.size()); }

} // namespace tension_ogre
