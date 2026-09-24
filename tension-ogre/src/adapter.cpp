// The adapter shim: the vtable the session loads, the three imports the guest
// calls, and the render thread they start.
//
// The split this file implements is the ABI's: `init`/`link`/`publish`/`apply`/
// `shutdown`/`destroy` are called on the interpreter thread, while everything
// that owns a renderer — construction, frames, teardown — happens on a thread
// of our own. The two halves talk through the status mirror and `post_event`,
// which are the only two things the ABI lets a background thread touch
// (tension_adapter.h rules 2 and 7).

#include "adapter.h"

#include <algorithm>
#include <cerrno>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <exception>
#include <string>

#include "../include/tension_ogre.h"
#include "backend.h"
#include "loader.h"
#include "mounts.h"

namespace tension_ogre {
namespace {

/// The verb ids this adapter declares. They are stable for the adapter's
/// lifetime and are what `apply` would be handed, once a verb is deferrable.
constexpr uint32_t kVerbInit = 1;
constexpr uint32_t kVerbShutdown = 2;
constexpr uint32_t kVerbLastError = 3;
constexpr uint32_t kVerbQueueMesh = 4;
constexpr uint32_t kVerbQueueTexture = 5;
constexpr uint32_t kVerbJobState = 6;
constexpr uint32_t kVerbJobRelease = 7;
constexpr uint32_t kVerbSubmit = 8;
constexpr uint32_t kVerbScreenshot = 9;
constexpr uint32_t kVerbSubmitMotion = 10;
constexpr uint32_t kVerbSubmitBones = 11;
constexpr uint32_t kVerbCreateMesh = 12;
// Note: 13, not 12 — `create_mesh` already holds 12, and a second verb on the
// same id would shadow it (the 11b plan said "verb_id 12"; the count it was
// after is the thirteenth verb, which is id 13).
constexpr uint32_t kVerbMountTns = 13;
// 14, not 15: the ids run 1..13 above, so the next verb is the fourteenth (the
// same off-by-one the 11b plan had for mount_tns — the count it wanted, the id
// it named, and the free slot differed by one).
constexpr uint32_t kVerbSubmitAnimation = 14;

/// The longest clip name this verb accepts, in bytes. Clip names are the
/// exporter's (`idle`, `run`, `jump`); 64 leaves room and keeps a garbage
/// length from being copied out of guest memory.
constexpr uint32_t kMaxClipNameBytes = 64;

/// The longest resource name this adapter will copy out of guest memory.
constexpr uint32_t kMaxNameBytes = 4096;

/// A config larger than this is not a config.
constexpr uint32_t kMaxConfigBytes = 512;

/// How long `shutdown` waits for the render thread to tear down and exit.
constexpr uint32_t kJoinTimeoutMs = 5000;

/// `Resource` field offsets (`assembly/ogre/wire.ts`; the layout hash covers
/// them, so this file and the catalogue move together).
constexpr size_t kResourceIdOffset = 0;
constexpr size_t kResourceKindOffset = 4;
constexpr size_t kResourceStateOffset = 8;
constexpr size_t kResourceErrorOffset = 28;
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

void put_u64(uint8_t *at, size_t offset, uint64_t value) {
    for (size_t i = 0; i < 8; ++i) at[offset + i] = static_cast<uint8_t>(value >> (8 * i));
}

/// One line to the session's log. The session prefixes its own channel name, so
/// the message names the module: `[tension:session] ogre: ...` (DESIGN.md §6.1).
void log_line(int32_t level, const std::string &message) {
    AdapterState &s = adapter_state();
    if (s.api == nullptr || s.api->log == nullptr) return;
    s.api->log(s.api->user, level, message.data(), static_cast<uint32_t>(message.size()));
}

/// Post one event. The only call in this file that a non-guest thread makes.
void post_event(uint32_t class_id, uint32_t a, uint32_t b) {
    AdapterState &s = adapter_state();
    if (s.api == nullptr || s.api->post_event == nullptr) return;
    s.api->post_event(s.api->user, s.source_id, class_id, 0, a, b, 0.0f, 0.0f, nullptr);
}

/// The render thread's failure path: the record, the log, and the event. Every
/// catchable failure goes through here — never through an escaping exception
/// (DESIGN.md §8.1).
void fail(uint32_t stage, int32_t error, const std::string &what) {
    AdapterState &s = adapter_state();
    char line[400];
    std::snprintf(line, sizeof(line), "ogre: %s (stage %u, errno %d)", what.c_str(), stage, error);
    s.status.set_error(stage, error, line);
    log_line(3, line);
    post_event(TENSION_OGRE_CLASS_DEVICE_LOST, stage, static_cast<uint32_t>(error));
}

/// Mark the thread done and destroy the backend — on this thread, which is the
/// only thread that may touch a render system's objects.
void finish_thread() {
    AdapterState &s = adapter_state();
    {
        std::lock_guard<std::mutex> lock(s.mutex);
        s.backend.reset();
        s.thread_exited = true;
    }
    s.cv.notify_all();
}

/// The render thread. Start, then frames until asked to stop or one fails, then
/// stop — all of it inside the catch that keeps a capability's failure from
/// becoming the process's death.
void render_main() {
    AdapterState &s = adapter_state();
    try {
        s.status.set_state(TENSION_OGRE_RES_STATE_LOADING);
        s.status.set_stage(TENSION_OGRE_STAGE_PLUGIN);

        s.backend = make_backend(s.config);
        if (s.backend == nullptr) {
            // Two ways to have no backend, and the guest deserves to know which:
            // a renderer this build's enum has but its plugins do not, or a
            // build with no OGRE at all.
            const bool named_renderer = s.config.renderer == TENSION_OGRE_RENDERER_METAL ||
                                        s.config.renderer == TENSION_OGRE_RENDERER_VULKAN;
            char line[200];
            std::snprintf(line, sizeof(line),
                          "no backend for renderer %u: %s", s.config.renderer,
                          named_renderer
                              ? "metal and vulkan are not in this build's plugins"
                              : "this build has no OGRE-Next; only renderer=null is available");
            fail(TENSION_OGRE_STAGE_PLUGIN, -ENOSYS, line);
            finish_thread();
            return;
        }

        // How the scene apply path turns a guest-visible resource id into one
        // of this backend's handles: the loader's RESOURCE table is the only
        // thing that knows both numbers.
        s.backend->set_resource_lookup([](uint32_t resource_id) -> ResourceHandle {
            return adapter_state().loader.resource_at(resource_id).handle;
        });

        const int32_t started = s.backend->start(s.config, s.status);
        if (started != 0) {
            // stop() even after a failed start: it unwinds whatever start
            // managed to create before it gave up.
            fail(s.status.snapshot().stage, started, "the renderer failed to start");
            s.backend->stop(s.status);
            finish_thread();
            return;
        }

        s.status.set_stage(TENSION_OGRE_STAGE_COMPLETE);
        s.status.set_state(TENSION_OGRE_RES_STATE_READY);
        post_event(TENSION_OGRE_CLASS_RESOURCE_READY, TENSION_OGRE_RESOURCE_RENDERER, 0);

        const uint32_t hz = s.config.frame_hz == 0 ? 60u : s.config.frame_hz;
        const std::chrono::milliseconds period(1000 / hz);
        while (!s.stop_requested.load()) {
            // Realise whatever the worker finished, on this thread — the only
            // one allowed to touch OGRE.
            s.loader.drain_completions(*s.backend);
            // The mirror's dirty lists become OGRE objects, on this thread,
            // before the frame that draws them. The lock is the guest
            // thread's: a `submit` that lands mid-apply waits for the next
            // frame rather than racing the record it writes.
            {
                std::lock_guard<std::mutex> scene_lock(s.scene_mutex);
                s.backend->apply_submissions(s.scene);
                s.scene.clear_dirty();
            }

            // Animation requests (13c), *after* the apply that creates the
            // renderables and *before* the frame that draws them. Order is the
            // whole point: the first frame a guest can name a clip is the
            // frame its `submitRenderable` lands on, and a request drained
            // before that apply has no item to name (measured: the first
            // frame's four requests were refused "not a live renderable").
            // The skeletons belong to this thread; the queue is the guest's,
            // so it is swapped empty under the guest lock and applied outside
            // it.
            {
                std::vector<AdapterState::AnimationRequest> requests;
                {
                    std::lock_guard<std::mutex> lock(s.mutex);
                    requests.swap(s.animations);
                }
                for (const AdapterState::AnimationRequest &request : requests) {
                    const int32_t set = s.backend->set_animation(
                        request.renderable_id, request.clip,
                        static_cast<double>(request.time_ms) / 1000.0);
                    if (set != 0) {
                        char line[224];
                        std::snprintf(line, sizeof(line),
                                      "ogre: submit_animation(%u, \"%s\") refused (%d)",
                                      request.renderable_id, request.clip.c_str(), set);
                        log_line(3, line);
                    }
                }
            }
            const int32_t framed = s.backend->frame(s.status);
            if (framed > 0) break; // the renderer ended normally (window closed)
            if (framed < 0) {
                fail(TENSION_OGRE_STAGE_FRAME, framed, "a frame failed");
                break;
            }
            std::unique_lock<std::mutex> lock(s.mutex);
            // Bounded wait, so a stop request is honoured immediately and an
            // idle loop does not spin.
            s.cv.wait_for(lock, period, [&s] { return s.stop_requested.load(); });
        }
        // Whatever was still being read when the loop ended never gets
        // realised: the renderer it was meant for is about to be torn down.
        s.loader.sweep_failed(-EIO);
        s.backend->stop(s.status);
    } catch (const std::exception &e) {
        fail(s.status.snapshot().stage, -EIO, std::string("unhandled exception: ") + e.what());
    } catch (...) {
        fail(s.status.snapshot().stage, -EIO, "unhandled exception of unknown type");
    }
    finish_thread();
}

// ── the imports ──────────────────────────────────────────────────────────

int32_t shim_init(void *, const tension_value *args, uint32_t nargs, tension_value *ret) {
    AdapterState &s = adapter_state();
    if (ret == nullptr || args == nullptr || nargs != 2) return -EINVAL;

    const uint32_t cfg_ptr = static_cast<uint32_t>(args[0].i32);
    const uint32_t cfg_len = static_cast<uint32_t>(args[1].i32);
    if (cfg_len == 0 || cfg_len > kMaxConfigBytes) {
        log_line(3, "ogre: init refused: the config length is out of range");
        return -EINVAL;
    }
    if (s.api == nullptr || s.api->guest_read == nullptr) return -EBUSY;

    uint8_t bytes[kMaxConfigBytes];
    if (s.api->guest_read(s.api->user, cfg_ptr, bytes, cfg_len) != 0) {
        log_line(3, "ogre: init refused: the config bytes are not readable");
        return -EINVAL;
    }

    const ConfigDecodeResult decoded = decode_config(bytes, cfg_len);
    if (!decoded.ok) {
        const std::string line = "ogre: init refused: " + decoded.message;
        s.status.note_message(line);
        log_line(3, line);
        return -EINVAL;
    }

    {
        std::lock_guard<std::mutex> lock(s.mutex);
        if (s.initialized || s.shutting_down) {
            log_line(2, "ogre: init refused: the adapter is already running");
            return -EBUSY;
        }
        s.config = decoded.config;
        s.stop_requested = false;
        s.thread_exited = false;
        s.thread = std::thread(render_main);
        s.initialized = true;
    }
    ret->i32 = 0; // accepted: the window is not up yet, and readiness is an event
    return 0;
}

int32_t shim_shutdown(void *, const tension_value *, uint32_t, tension_value *ret) {
    AdapterState &s = adapter_state();
    if (ret == nullptr) return -EINVAL;
    {
        std::lock_guard<std::mutex> lock(s.mutex);
        if (!s.initialized) {
            ret->i32 = 0; // nothing to stop is not a failure
            return 0;
        }
        s.shutting_down = true;
    }
    ret->i32 = stop_and_join(kJoinTimeoutMs);
    return 0;
}

int32_t shim_last_error(void *, const tension_value *args, uint32_t nargs, tension_value *ret) {
    AdapterState &s = adapter_state();
    if (ret == nullptr || args == nullptr || nargs != 2) return -EINVAL;

    const uint32_t ptr = static_cast<uint32_t>(args[0].i32);
    const int32_t cap = args[1].i32;
    const int32_t length = s.status.message_length();
    if (length <= 0) {
        ret->i32 = -1; // nothing to report is the normal case
        return 0;
    }
    if (cap <= 0) {
        ret->i32 = length; // probe: the length, nothing consumed
        return 0;
    }

    char scratch[kMessageBytes];
    const size_t room = static_cast<size_t>(cap) < sizeof(scratch) ? static_cast<size_t>(cap)
                                                                   : sizeof(scratch);
    const int32_t taken = s.status.take_message(scratch, room);
    if (taken <= 0) {
        ret->i32 = -1;
        return 0;
    }
    if (s.api == nullptr || s.api->guest_write == nullptr) return -EBUSY;
    if (s.api->guest_write(s.api->user, ptr, scratch, static_cast<uint32_t>(taken)) != 0) {
        return -EINVAL;
    }
    ret->i32 = taken;
    return 0;
}

/// Copy a name out of guest memory. It must be copied here — the ABI forbids
/// holding a guest pointer, and the worker thread may not touch guest memory
/// at all — which is also why the loader stores the string itself.
bool read_guest_name(const tension_core_api *api, uint32_t ptr, uint32_t len, std::string &out) {
    if (api == nullptr || api->guest_read == nullptr) return false;
    if (len == 0 || len > kMaxNameBytes) return false;
    out.resize(len);
    if (api->guest_read(api->user, ptr, out.data(), len) != 0) return false;
    return true;
}

int32_t shim_queue(void *ctx, const tension_value *args, uint32_t nargs, tension_value *ret,
                   uint32_t kind) {
    (void)ctx;
    AdapterState &s = adapter_state();
    if (ret == nullptr || args == nullptr || nargs != 3) return -EINVAL;

    const uint32_t name_ptr = static_cast<uint32_t>(args[0].i32);
    const uint32_t name_len = static_cast<uint32_t>(args[1].i32);
    const int32_t priority = args[2].i32;

    std::string name;
    if (!read_guest_name(s.api, name_ptr, name_len, name)) {
        log_line(3, "ogre: queue refused: the name is unreadable or too long");
        return -EINVAL;
    }

    const int32_t job = s.loader.queue(kind, name, name_ptr, name_len, priority);
    if (job < 0) return job; // -ENOSPC: the table is full, and said so in the log
    ret->i32 = job;
    return 0;
}

/// `submit_animation(renderableId, clip_ptr, clip_len, time_ms)`: name a clip
/// on a renderable's rig and put it at an absolute time (chunk 13c). The guest
/// owns the clock — one call per renderable per frame, the same shape as the
/// bone table's per-frame pose, but the *adapter* drives OGRE's animation
/// system instead of the guest writing bone transforms. Queued, not applied
/// here: the skeleton belongs to the render thread.
int32_t shim_submit_animation(void *, const tension_value *args, uint32_t nargs,
                              tension_value *ret) {
    AdapterState &s = adapter_state();
    if (ret == nullptr || args == nullptr || nargs != 4) return -EINVAL;
    const uint32_t renderable_id = static_cast<uint32_t>(args[0].i32);
    const uint32_t clip_ptr = static_cast<uint32_t>(args[1].i32);
    const uint32_t clip_len = static_cast<uint32_t>(args[2].i32);
    const int32_t time_ms = args[3].i32;

    std::string clip;
    if (!read_guest_name(s.api, clip_ptr, clip_len, clip) || clip.size() > kMaxClipNameBytes) {
        log_line(3, "ogre: submit_animation refused: the clip name is unreadable, empty, or longer "
                    "than 64 bytes");
        return -EINVAL;
    }
    if (renderable_id == 0 || time_ms <= 0) {
        char line[160];
        std::snprintf(line, sizeof(line),
                      "ogre: submit_animation refused: renderable %u at %d ms",
                      renderable_id, time_ms);
        log_line(3, line);
        return -EINVAL;
    }

    {
        std::lock_guard<std::mutex> lock(s.mutex);
        s.animations.push_back(AdapterState::AnimationRequest{renderable_id, std::move(clip), time_ms});
    }
    ret->i32 = 0;
    return 0;
}

int32_t shim_queue_mesh(void *ctx, const tension_value *args, uint32_t nargs, tension_value *ret) {
    return shim_queue(ctx, args, nargs, ret, TENSION_OGRE_RES_KIND_MESH);
}

/// `mount_tns(prefix_ptr, prefix_len, tns_ptr, tns_len)`: read a Tension Volume
/// off the disk once, hand its bytes to the resource library, and mount it
/// under a prefix the load paths resolve against (chunk 11). The disk is
/// touched exactly once per mount, here — reads never see it again.
int32_t shim_mount_tns(void *, const tension_value *args, uint32_t nargs, tension_value *ret) {
    AdapterState &s = adapter_state();
    if (ret == nullptr || args == nullptr || nargs != 4) return -EINVAL;

    const uint32_t prefix_ptr = static_cast<uint32_t>(args[0].i32);
    const uint32_t prefix_len = static_cast<uint32_t>(args[1].i32);
    const uint32_t tns_ptr = static_cast<uint32_t>(args[2].i32);
    const uint32_t tns_len = static_cast<uint32_t>(args[3].i32);

    std::string prefix;
    std::string tns_path;
    if (!read_guest_name(s.api, prefix_ptr, prefix_len, prefix) ||
        !read_guest_name(s.api, tns_ptr, tns_len, tns_path)) {
        log_line(3, "ogre: mount_tns refused: the prefix or the path is unreadable or too long");
        return -EINVAL;
    }

    std::vector<uint8_t> bytes;
    tension_res *res = nullptr;
    std::string err;
    const int32_t opened = mount_open(tns_path, &bytes, &res, &err);
    if (opened != 0) {
        log_line(3, "ogre: mount_tns refused: " + tns_path + " could not be opened (" +
                         std::to_string(opened) + ")" + (err.empty() ? "" : ": " + err));
        return opened;
    }

    const int32_t mounted = s.loader.add_mount(prefix, tns_path, std::move(bytes), res);
    if (mounted != 0) {
        log_line(3, "ogre: mount_tns refused: prefix \"" + prefix + "\" (" +
                         std::to_string(mounted) + ")");
        tension_res_free(res);
        return mounted;
    }
    log_line(1, "ogre: mounted \"" + prefix + "/\" from " + tns_path);
    ret->i32 = 0;
    return 0;
}

int32_t shim_queue_texture(void *ctx, const tension_value *args, uint32_t nargs,
                           tension_value *ret) {
    return shim_queue(ctx, args, nargs, ret, TENSION_OGRE_RES_KIND_TEXTURE);
}

int32_t shim_job_state(void *, const tension_value *args, uint32_t nargs, tension_value *ret) {
    AdapterState &s = adapter_state();
    if (ret == nullptr || args == nullptr || nargs != 2) return -EINVAL;
    const uint32_t job_id = static_cast<uint32_t>(args[0].i32);
    const uint32_t out_ptr = static_cast<uint32_t>(args[1].i32);

    uint8_t record[TENSION_OGRE_JOB_RECORD_BYTES] = {};
    const int32_t found = s.loader.job_state(job_id, record);
    if (found != 0) return found; // -ENOENT
    if (s.api == nullptr || s.api->guest_write == nullptr) return -EBUSY;
    if (s.api->guest_write(s.api->user, out_ptr, record, TENSION_OGRE_JOB_RECORD_BYTES) != 0) {
        return -EINVAL;
    }
    ret->i32 = 0;
    return 0;
}

int32_t shim_job_release(void *, const tension_value *args, uint32_t nargs, tension_value *ret) {
    AdapterState &s = adapter_state();
    if (ret == nullptr || args == nullptr || nargs != 1) return -EINVAL;
    const int32_t released = s.loader.job_release(static_cast<uint32_t>(args[0].i32));
    if (released != 0) return released;
    ret->i32 = 0;
    return 0;
}

/// `ogre::submit(kind, id, op)` — the guest's record is already in its region;
/// this says which one changed. The record is copied out here, decoded, and
/// handed to the mirror, which is what the render thread will act on.
int32_t shim_submit(void *, const tension_value *args, uint32_t nargs, tension_value *ret) {
    AdapterState &s = adapter_state();
    if (ret == nullptr || args == nullptr || nargs != 3) return -EINVAL;
    const uint32_t kind = static_cast<uint32_t>(args[0].i32);
    const uint32_t id = static_cast<uint32_t>(args[1].i32);
    const uint32_t op = static_cast<uint32_t>(args[2].i32);
    if (op != kSubmitUpsert && op != kSubmitRemove) return -EINVAL;
    // The mirror is read by the render thread each frame; this is the one
    // writer, and the lock is what keeps the two from overlapping.
    std::lock_guard<std::mutex> scene_lock(s.scene_mutex);

    if (op == kSubmitRemove) {
        int32_t rc = 0;
        switch (kind) {
            case kSubmitNode: rc = s.scene.remove_node(id); break;
            case kSubmitCamera: rc = s.scene.remove_camera(id); break;
            case kSubmitLight: rc = s.scene.remove_light(id); break;
            case kSubmitMaterial: rc = s.scene.remove_material(id); break;
            case kSubmitRenderable: rc = s.scene.remove_renderable(id); break;
            default: return -EINVAL;
        }
        if (rc != 0) return rc;
        ret->i32 = 0;
        return 0;
    }

    // Upsert: bounds first, then one record's worth of bytes out of the region.
    uint32_t base = 0, table_offset = 0, record_bytes = 0, capacity = 0;
    switch (kind) {
        case kSubmitNode:
            base = s.scene_offset; table_offset = 0; record_bytes = kNodeRecordBytes;
            capacity = kNodeCapacity;
            break;
        case kSubmitCamera:
            base = s.scene_offset; table_offset = kCameraTableOffset;
            record_bytes = kCameraRecordBytes; capacity = kCameraCapacity;
            break;
        case kSubmitLight:
            base = s.scene_offset; table_offset = kLightTableOffset;
            record_bytes = kLightRecordBytes; capacity = kLightCapacity;
            break;
        case kSubmitMaterial:
            base = s.material_offset; table_offset = 0; record_bytes = kMaterialRecordBytes;
            capacity = kMaterialCapacity;
            break;
        case kSubmitRenderable:
            base = s.renderable_offset; table_offset = 0; record_bytes = kRenderableRecordBytes;
            capacity = kRenderableCapacity;
            break;
        default:
            return -EINVAL;
    }
    if (id == 0 || id > capacity) return -EINVAL;
    if (s.api == nullptr || s.api->guest_read == nullptr) return -EBUSY;

    // Sized by the *wire* record, not by the decoder struct: `MaterialRecord`
    // decodes the fields this adapter reads (through slot 0) and is 88 bytes,
    // while the region's record is 208. Reading a wire record into a buffer
    // sized from the struct is a stack overflow — measured, in this shim's
    // first run, as `*** stack smashing detected ***`.
    constexpr size_t kMaxRecordBytes = kMaterialRecordBytes;
    uint8_t record[kMaxRecordBytes] = {};
    const uint32_t at = base + table_offset + (id - 1) * record_bytes;
    if (s.api->guest_read(s.api->user, at, record, record_bytes) != 0) return -EINVAL;

    int32_t rc = 0;
    switch (kind) {
        case kSubmitNode: {
            SceneNodeRecord decoded;
            if (!SceneMirror::decode_node_at(record, decoded)) return -EINVAL;
            rc = s.scene.upsert_node(id, decoded);
            break;
        }
        case kSubmitCamera: {
            CameraRecord decoded;
            if (!SceneMirror::decode_camera_at(record, decoded)) return -EINVAL;
            rc = s.scene.upsert_camera(id, decoded);
            break;
        }
        case kSubmitLight: {
            LightRecord decoded;
            if (!SceneMirror::decode_light_at(record, decoded)) return -EINVAL;
            rc = s.scene.upsert_light(id, decoded);
            break;
        }
        case kSubmitMaterial: {
            MaterialRecord decoded;
            if (!SceneMirror::decode_material_at(record, decoded)) return -EINVAL;
            rc = s.scene.upsert_material(id, decoded);
            break;
        }
        // Explicit, not a `default`: a kind this adapter does not know must be
        // refused, and a `default` that decodes a renderable would turn the
        // next kind added to the wire into a silently misrouted record. The
        // remove switch below already refuses by name for the same reason.
        case kSubmitRenderable: {
            RenderableRecord decoded;
            if (!SceneMirror::decode_renderable_at(record, decoded)) return -EINVAL;
            rc = s.scene.upsert_renderable(id, decoded);
            break;
        }
        default: return -EINVAL;
    }
    if (rc != 0) return rc;
    ret->i32 = 0;
    return 0;
}

/// `ogre::submit_motion(count)` — the motion table, read in one call (chunk 4).
///
/// The guest writes `count` 64-byte `MotionUpdate` records at the start of
/// `BUFFER_POOL` and names them here: one wasm→host transition per frame
/// instead of one per body. The batch is **all-or-nothing** — an entry naming a
/// renderable the mirror does not hold live refuses the whole call with
/// `-ENOENT` and a line naming the entry — because a half-applied frame is
/// worse than a refused one, and the guest can say what it did wrong.
///
/// This is the only guest memory the motion path touches, and it is touched in
/// one of the three phases the ABI permits (an import call, on the guest
/// thread). `publish` is not engaged: motion writes nothing to guest memory, so
/// the epoch's byte budget is untouched.
int32_t shim_submit_motion(void *, const tension_value *args, uint32_t nargs, tension_value *ret) {
    AdapterState &s = adapter_state();
    if (ret == nullptr || args == nullptr || nargs != 1) return -EINVAL;
    const int32_t count = args[0].i32;
    if (count <= 0 || count > static_cast<int32_t>(kMotionCapacity)) {
        char line[160];
        std::snprintf(line, sizeof(line), "ogre: submit_motion refused: %d entries is not in 1..%u",
                      count, kMotionCapacity);
        log_line(3, line);
        return -EINVAL;
    }
    const size_t bytes = static_cast<size_t>(count) * kMotionRecordBytes;
    if (s.motion_size < bytes) {
        log_line(3, "ogre: submit_motion refused: the BUFFER_POOL region is smaller than "
                    "this batch");
        return -EINVAL;
    }
    if (s.api == nullptr || s.api->guest_read == nullptr) return -EBUSY;

    // One read for the whole table: this is the call the batch exists to make
    // cheap, and the copy is what makes the batch safe to validate first.
    std::vector<uint8_t> table(bytes);
    if (s.api->guest_read(s.api->user, s.motion_offset, table.data(),
                          static_cast<uint32_t>(bytes)) != 0) {
        return -EINVAL;
    }

    std::lock_guard<std::mutex> scene_lock(s.scene_mutex);
    std::vector<MotionUpdate> batch(static_cast<size_t>(count));
    for (int32_t i = 0; i < count; ++i) {
        const uint8_t *entry = table.data() + static_cast<size_t>(i) * kMotionRecordBytes;
        if (!SceneMirror::decode_motion_at(entry, batch[static_cast<size_t>(i)])) return -EINVAL;
        const uint32_t id = batch[static_cast<size_t>(i)].renderable_id;
        if (id == 0 || id > kRenderableCapacity || !s.scene.renderable_live(id)) {
            char line[200];
            std::snprintf(line, sizeof(line),
                          "ogre: submit_motion refused: entry %d names renderable %u, which is "
                          "not live",
                          i, id);
            log_line(3, line);
            return -ENOENT;
        }
    }
    for (int32_t i = 0; i < count; ++i) {
        // Cannot fail here: liveness was checked under this same lock, and the
        // batch is applied in one go so no epoch can see half of it.
        s.scene.apply_motion(batch[static_cast<size_t>(i)].renderable_id,
                             batch[static_cast<size_t>(i)]);
    }
    ret->i32 = count;
    return 0;
}

/// `ogre::submit_bones(count)` — the bone table, read in one call (chunk 5b).
///
/// The same shape as `submit_motion`, one table further into `BUFFER_POOL`: the
/// guest writes `count` 64-byte `BoneUpdate` records at `BONE_TABLE_OFFSET` and
/// names them here. The batch is all-or-nothing for the same reason motion's is
/// — a half-applied pose is a rig bent to a shape nobody asked for — and for one
/// more: validation asks the loader for the target's bone count, so a batch that
/// is refused is refused before any bone moves.
///
/// Like motion, this touches guest memory once (the one `guest_read`), on the
/// guest thread, inside an import call. `publish` is not engaged.
int32_t shim_submit_bones(void *, const tension_value *args, uint32_t nargs, tension_value *ret) {
    AdapterState &s = adapter_state();
    if (ret == nullptr || args == nullptr || nargs != 1) return -EINVAL;
    const int32_t count = args[0].i32;
    if (count <= 0 || count > static_cast<int32_t>(kBoneCapacity)) {
        char line[160];
        std::snprintf(line, sizeof(line), "ogre: submit_bones refused: %d entries is not in 1..%u",
                      count, kBoneCapacity);
        log_line(3, line);
        return -EINVAL;
    }
    const size_t bytes = static_cast<size_t>(count) * kBoneRecordBytes;
    if (s.motion_size < kBoneTableOffset + bytes) {
        log_line(3, "ogre: submit_bones refused: the BUFFER_POOL region is smaller than "
                    "the bone table");
        return -EINVAL;
    }
    if (s.api == nullptr || s.api->guest_read == nullptr) return -EBUSY;

    std::vector<uint8_t> table(bytes);
    if (s.api->guest_read(s.api->user, s.motion_offset + kBoneTableOffset, table.data(),
                          static_cast<uint32_t>(bytes)) != 0) {
        return -EINVAL;
    }

    std::lock_guard<std::mutex> scene_lock(s.scene_mutex);
    std::vector<BoneUpdate> batch(static_cast<size_t>(count));
    for (int32_t i = 0; i < count; ++i) {
        const uint8_t *entry = table.data() + static_cast<size_t>(i) * kBoneRecordBytes;
        if (!SceneMirror::decode_bone_at(entry, batch[static_cast<size_t>(i)])) return -EINVAL;
    }
    // The mirror owns the liveness and rig checks, and owns the message that
    // names the entry that failed: it is the only thing holding both tables and
    // the loader's rig knowledge at once.
    const int32_t applied = s.scene.apply_bones(batch.data(), static_cast<uint32_t>(count));
    if (applied != 0) {
        char line[200];
        std::snprintf(line, sizeof(line),
                      "ogre: submit_bones refused a batch of %d (errno %d); nothing applied",
                      count, applied);
        log_line(3, line);
        return applied;
    }
    ret->i32 = count;
    return 0;
}

/// `ogre::create_mesh(vbOffset, vbBytes, format, ibOffset, ibBytes, topology)`
/// — a mesh built from arrays the guest wrote into `BUFFER_POOL` (chunk 5.5).
///
/// Both arrays live in the window past the bone table (`kProceduralBase`,
/// `kProceduralCapacity`) and both are named by their **arena offset** — the
/// same kind of number `queue_mesh_load` takes for a name and `screenshot`
/// takes for a buffer. The guest writes at
/// `regionOffset(REGION_BUFFER_POOL) + PROCEDURAL_BASE + n` and passes that
/// number, so the memory it wrote and the memory it names are one expression
/// rather than two.
///
/// Everything a GPU could read out of bounds is refused here, because the guest
/// is the only author of this data: the window, the format's element set, the
/// arrays' shapes, and every index against the vertex count — an index past the
/// last vertex is a read the renderer performs with nobody to blame.
///
/// The id comes back now, and the mesh is built by the render thread on its
/// next pass (only that thread may make an OGRE object), which is why a
/// realisation failure lands in the resource record instead of in this return
/// value. `publish` is not engaged: this verb writes nothing to guest memory.
int32_t shim_create_mesh(void *, const tension_value *args, uint32_t nargs, tension_value *ret) {
    AdapterState &s = adapter_state();
    if (ret == nullptr || args == nullptr || nargs != 6) return -EINVAL;
    const uint32_t vertex_offset = static_cast<uint32_t>(args[0].i32);
    const uint32_t vertex_bytes = static_cast<uint32_t>(args[1].i32);
    const uint32_t format = static_cast<uint32_t>(args[2].i32);
    const uint32_t index_offset = static_cast<uint32_t>(args[3].i32);
    const uint32_t index_bytes = static_cast<uint32_t>(args[4].i32);
    const uint32_t topology = static_cast<uint32_t>(args[5].i32);

    if (topology != kTopoTriangleList) {
        log_line(3, "ogre: create_mesh refused: topology " + std::to_string(topology) +
                        " is not TOPO_TRIANGLE_LIST");
        return -EINVAL;
    }
    if ((format & kVfPosition) == 0 || (format & ~(kVfPosition | kVfNormal | kVfUv)) != 0) {
        log_line(3, "ogre: create_mesh refused: format " + std::to_string(format) +
                        " is not a set of VF_ bits that includes VF_POSITION");
        return -EINVAL;
    }
    const size_t stride = 12 + ((format & kVfNormal) != 0 ? 12 : 0) +
                          ((format & kVfUv) != 0 ? 8 : 0);
    if (vertex_bytes == 0 || vertex_bytes % stride != 0) {
        log_line(3, "ogre: create_mesh refused: " + std::to_string(vertex_bytes) +
                        " vertex bytes is not a whole number of " + std::to_string(stride) +
                        "-byte vertices");
        return -EINVAL;
    }
    if (index_bytes == 0 || index_bytes % 6 != 0) {
        log_line(3, "ogre: create_mesh refused: " + std::to_string(index_bytes) +
                        " index bytes is not a whole number of 16-bit triangles");
        return -EINVAL;
    }

    const uint64_t window = static_cast<uint64_t>(s.motion_offset) + kProceduralBase;
    const uint64_t window_end = window + kProceduralCapacity;
    const uint64_t vertex_end = static_cast<uint64_t>(vertex_offset) + vertex_bytes;
    const uint64_t index_end = static_cast<uint64_t>(index_offset) + index_bytes;
    if (vertex_offset < window || vertex_end > window_end || index_offset < window ||
        index_end > window_end) {
        char line[220];
        std::snprintf(line, sizeof(line),
                      "ogre: create_mesh refused: vertex [%u,%llu) and index [%u,%llu) are not "
                      "both inside BUFFER_POOL's procedural window [%llu,%llu)",
                      vertex_offset, static_cast<unsigned long long>(vertex_end), index_offset,
                      static_cast<unsigned long long>(index_end),
                      static_cast<unsigned long long>(window),
                      static_cast<unsigned long long>(window_end));
        log_line(3, line);
        return -EINVAL;
    }
    if (vertex_offset < index_end && index_offset < vertex_end) {
        log_line(3, "ogre: create_mesh refused: the vertex and index arrays overlap");
        return -EINVAL;
    }
    if (s.api == nullptr || s.api->guest_read == nullptr) return -EBUSY;

    std::vector<uint8_t> vertices(vertex_bytes);
    std::vector<uint8_t> indices(index_bytes);
    if (s.api->guest_read(s.api->user, vertex_offset, vertices.data(), vertex_bytes) != 0) {
        return -EINVAL;
    }
    if (s.api->guest_read(s.api->user, index_offset, indices.data(), index_bytes) != 0) {
        return -EINVAL;
    }

    // Every index against the vertex count. Two lines, and they are the
    // difference between a refusal a guest can act on and a GPU reading past
    // the end of a buffer.
    const size_t vertex_count = vertex_bytes / stride;
    for (size_t i = 0; i < index_bytes / 2; ++i) {
        uint16_t index = 0;
        std::memcpy(&index, indices.data() + i * 2, 2);
        if (index >= vertex_count) {
            char line[200];
            std::snprintf(line, sizeof(line),
                          "ogre: create_mesh refused: index %zu names vertex %u, past the %zu "
                          "vertices given",
                          i, static_cast<unsigned>(index), vertex_count);
            log_line(3, line);
            return -EINVAL;
        }
    }

    const int32_t resource_id =
        s.loader.queue_procedural_mesh(vertices.data(), vertex_bytes, format, indices.data(),
                                       index_bytes, topology);
    if (resource_id < 0) return resource_id;
    ret->i32 = resource_id;
    return 0;
}

/// `ogre::screenshot(ptr, cap)` — probe/consume over the last downloaded frame,
/// and a request for the next one. `cap <= 0` asks the length; `cap > 0` copies
/// `min(cap, len)` bytes and consumes them. `-1` means no frame is available.
///
/// The request is what makes the next frame worth downloading, so a guest that
/// wants pixels asks at least one frame ahead of reading them.
int32_t shim_screenshot(void *, const tension_value *args, uint32_t nargs, tension_value *ret) {
    AdapterState &s = adapter_state();
    if (ret == nullptr || args == nullptr || nargs != 2) return -EINVAL;

    if (s.backend) s.backend->request_readback();

    if (!s.backend) {
        ret->i32 = -1;
        return 0;
    }
    size_t length = 0;
    if (s.backend->readback(nullptr, 0, &length) <= 0 || length == 0) {
        ret->i32 = -1;
        return 0;
    }
    const uint32_t ptr = static_cast<uint32_t>(args[0].i32);
    const int32_t cap = args[1].i32;
    if (cap <= 0) {
        ret->i32 = static_cast<int32_t>(length);
        return 0;
    }
    if (s.api == nullptr || s.api->guest_write == nullptr) return -EBUSY;
    // The copy is the backend's, under its own lock: the render thread owns
    // the frame buffer and must not be holding it while the guest reads.
    const size_t take = std::min(static_cast<size_t>(cap), length);
    std::vector<uint8_t> pixels(take);
    size_t copied = 0;
    if (s.backend->readback(pixels.data(), take, &copied) <= 0 || copied == 0) {
        ret->i32 = -1;
        return 0;
    }
    if (s.api->guest_write(s.api->user, ptr, pixels.data(), static_cast<uint32_t>(copied)) != 0) {
        return -EINVAL;
    }
    ret->i32 = static_cast<int32_t>(copied);
    return 0;
}

// ── the vtable ───────────────────────────────────────────────────────────

int32_t adapter_init(void *, const tension_core_api *core) {
    if (core == nullptr || core->abi_version != TENSION_ADAPTER_ABI_VERSION) return -EINVAL;
    adapter_state().api = core;
    return 0;
}

/// Registration happens here, not in `init`: the ABI is explicit that
/// `register_import` and `register_source` are valid only while `link` runs,
/// and the registry refuses them anywhere else.
int32_t adapter_link(void *, const tension_core_api *core) {
    AdapterState &s = adapter_state();
    if (core == nullptr) return -EINVAL;

    const uint32_t i32 = TENSION_VT_I32;
    const uint32_t one_i32[1] = {i32};
    const uint32_t two_i32[2] = {i32, i32};
    const uint32_t three_i32[3] = {i32, i32, i32};
    const uint32_t four_i32[4] = {i32, i32, i32, i32};
    const uint32_t six_i32[6] = {i32, i32, i32, i32, i32, i32};

    struct Registration {
        const char *name;
        const uint32_t *params;
        uint32_t nparams;
        tension_import_fn fn;
        uint32_t verb_id;
        uint32_t flags;
    };
    const Registration registrations[] = {
        {"init", two_i32, 2, shim_init, kVerbInit, 0},
        {"shutdown", nullptr, 0, shim_shutdown, kVerbShutdown, 0},
        {"last_error", two_i32, 2, shim_last_error, kVerbLastError,
         TENSION_IMPORT_REENTRANT_READONLY},
        {"queue_mesh_load", three_i32, 3, shim_queue_mesh, kVerbQueueMesh, 0},
        {"queue_texture_load", three_i32, 3, shim_queue_texture, kVerbQueueTexture, 0},
        // Reading a job record is the exempt-accessor case: no pump, no block.
        {"job_state", two_i32, 2, shim_job_state, kVerbJobState,
         TENSION_IMPORT_REENTRANT_READONLY},
        {"job_release", one_i32, 1, shim_job_release, kVerbJobRelease, 0},
        {"submit", three_i32, 3, shim_submit, kVerbSubmit, 0},
        {"screenshot", two_i32, 2, shim_screenshot, kVerbScreenshot,
         TENSION_IMPORT_REENTRANT_READONLY},
        // The batch path: one call per frame for N moving bodies (chunk 4).
        {"submit_motion", one_i32, 1, shim_submit_motion, kVerbSubmitMotion, 0},
        // And one per frame for a whole rig's pose (chunk 5b).
        {"submit_bones", one_i32, 1, shim_submit_bones, kVerbSubmitBones, 0},
        // A mesh out of guest memory, for a guest with no file to load (5.5).
        {"create_mesh", six_i32, 6, shim_create_mesh, kVerbCreateMesh, 0},
        {"mount_tns", four_i32, 4, shim_mount_tns, kVerbMountTns, 0},
        {"submit_animation", four_i32, 4, shim_submit_animation, kVerbSubmitAnimation, 0},
    };

    for (const Registration &registration : registrations) {
        const int32_t rc = core->register_import(core->user, "ogre", registration.name,
                                                 TENSION_VT_I32, registration.params,
                                                 registration.nparams, registration.fn, nullptr,
                                                 registration.verb_id, registration.flags);
        if (rc != 0) {
            char line[160];
            std::snprintf(line, sizeof(line), "ogre: link: registering `%s` refused (%d)",
                          registration.name, rc);
            log_line(3, line);
            return rc;
        }
    }

    const int32_t sourced = core->register_source(core->user, "ogre", 0, &s.source_id);
    if (sourced != 0) {
        log_line(3, "ogre: link: register_source refused");
        return sourced;
    }

    // The declaration of the one region this sub-chunk writes (DESIGN.md §7.2:
    // asking about a kind at link time *is* the declaration).
    const int32_t found = core->region_lookup(core->user, TENSION_REGION_RESOURCE,
                                              &s.resource_offset, &s.resource_size);
    if (found != 0) {
        log_line(3, "ogre: link: the RESOURCE region is not in this layout");
        return found;
    }
    const int32_t job_region =
        core->region_lookup(core->user, TENSION_REGION_JOB, &s.job_offset, &s.job_size);
    if (job_region != 0) {
        log_line(3, "ogre: link: the JOB region is not in this layout");
        return job_region;
    }

    // The guest-written regions this adapter reads. Asking for them at link is
    // the declaration (DESIGN.md §7.2), and the set is what `session_open`
    // checks the arena against.
    struct Region {
        uint32_t kind;
        uint32_t *offset;
        uint32_t *size;
        const char *name;
    };
    const Region submission_regions[] = {
        {TENSION_REGION_SCENE, &s.scene_offset, &s.scene_size, "SCENE"},
        {TENSION_REGION_MATERIAL, &s.material_offset, &s.material_size, "MATERIAL"},
        {TENSION_REGION_RENDERABLE, &s.renderable_offset, &s.renderable_size, "RENDERABLE"},
        {TENSION_REGION_BUFFER_POOL, &s.motion_offset, &s.motion_size, "BUFFER_POOL"},
    };
    for (const Region &region : submission_regions) {
        const int32_t found_region =
            core->region_lookup(core->user, region.kind, region.offset, region.size);
        if (found_region != 0) {
            log_line(3, std::string("ogre: link: the ") + region.name + " region is not in this layout");
            return found_region;
        }
        // `region_lookup` succeeding is not the same as the table being
        // complete: a region the table forgot is never asked for, and the shim
        // then reads address 0 as guest memory. Offset 0 is the arena's control
        // block, never a region, so this is the cheap start-time check that the
        // list above covers every region this adapter addresses.
        if (*region.offset == 0 || *region.size == 0) {
            log_line(3, std::string("ogre: link: the ") + region.name +
                            " region resolved to zero; the table is incomplete");
            return -EINVAL;
        }
    }

    // A renderable may only name a mesh that is loaded: the mirror asks the
    // loader rather than guessing, and refuses one that points at nothing.
    s.scene.set_resource_check([](uint32_t resource_id, uint32_t kind) {        const ResourceSlot resource = adapter_state().loader.resource_at(resource_id);
        return resource.resource_id == resource_id && resource.kind == kind &&
               resource.state == TENSION_OGRE_RES_STATE_READY;
    });

    // And where the mirror says why it refused: the walk that found a cycle,
    // the depth it measured, the child holding a node open. The adapter owns
    // the log, so the mirror only formats.
    s.scene.set_log([](const std::string &message) { log_line(3, "ogre: " + message); });

    // And whether a mesh can be posed at all. The loader records a rigged
    // mesh's bone count when the backend realises it; the mirror asks here so
    // that a bone batch aimed at a static mesh is refused rather than ignored.
    s.scene.set_bone_count(
        [](uint32_t resource_id) { return adapter_state().loader.resource_bone_count(resource_id); });

    // What the loader needs from the session, without knowing the session
    // exists: a way to post an event and a way to say something.
    LoaderSink sink;
    sink.post_event = [](uint32_t class_id, uint32_t a, uint32_t b) { post_event(class_id, a, b); };
    sink.log = [](int32_t level, const std::string &message) { log_line(level, message); };
    s.loader.set_sink(std::move(sink));

    // Where resource names are looked up: the media directory the build baked
    // in, unless the environment names another one (a path list, ':').
    std::vector<std::string> paths;
    if (const char *from_env = std::getenv("TENSION_OGRE_MEDIA_DIR")) {
        std::string list = from_env;
        size_t start = 0;
        while (start <= list.size()) {
            const size_t colon = list.find(':', start);
            const std::string piece = list.substr(start, colon - start);
            if (!piece.empty()) paths.push_back(piece);
            if (colon == std::string::npos) break;
            start = colon + 1;
        }
    } else {
#ifdef TENSION_OGRE_MEDIA_DIR
        paths.push_back(std::string(TENSION_OGRE_MEDIA_DIR) + "/models");
        paths.push_back(std::string(TENSION_OGRE_MEDIA_DIR) + "/materials/textures");
        paths.push_back(std::string(TENSION_OGRE_MEDIA_DIR) + "/packs");
#endif
    }
    s.loader.set_search_paths(std::move(paths));
    return 0;
}

/// The publish hook: the render thread's mirror, copied into the renderer's
/// `Resource` record. This is the only place this adapter writes guest memory.
int32_t adapter_publish(void *, const tension_core_api *core) {
    AdapterState &s = adapter_state();
    // Two independent sources of dirt: the renderer's own status and the job
    // table. Either one alone must be enough to run the hook — the job records
    // are what the guest's `jobState()` reads, and the renderer's slot is quiet
    // most epochs (which is exactly when a job would have been missed).
    const bool jobs_dirty = s.loader.has_dirty();
    if (!jobs_dirty && !s.status.dirty()) return 0; // no API needed, no budget spent
    if (core == nullptr || core->guest_write == nullptr) return -EINVAL;
    if (s.resource_size < TENSION_OGRE_RESOURCE_RECORD_BYTES) {
        log_line(3, "ogre: publish: the RESOURCE region is smaller than one record");
        return -ENOENT;
    }

    // Jobs and resources first: they are the records the guest's own
    // `jobState()` reads straight out of the region, so they matter more than
    // the renderer's own slot.
    if (jobs_dirty) {
        const Loader::GuestWrite write = [core](uint32_t ptr, const void *src, uint32_t len) {
            return core->guest_write(core->user, ptr, src, len);
        };
        s.loader.mirror_to_region(write, s.job_offset, s.resource_offset);
    }

    const StatusWriter::Snapshot snap = s.status.snapshot();
    uint8_t record[TENSION_OGRE_RESOURCE_RECORD_BYTES] = {};
    put_u32(record, kResourceIdOffset, TENSION_OGRE_RESOURCE_RENDERER);
    put_u32(record, kResourceKindOffset, TENSION_OGRE_RES_KIND_RENDERER);
    put_u32(record, kResourceStateOffset, snap.state);
    put_i32(record, kResourceErrorOffset, snap.error);
    put_u64(record, kResourceSeqOffset, snap.frames);

    const uint32_t at = s.resource_offset +
                        (TENSION_OGRE_RESOURCE_RENDERER - 1) * TENSION_OGRE_RESOURCE_RECORD_BYTES;
    const int32_t wrote =
        core->guest_write(core->user, at, record, TENSION_OGRE_RESOURCE_RECORD_BYTES);
    if (wrote != 0) {
        // -ENOSPC is this epoch's budget, not a bad range: stay dirty so the
        // next epoch finishes the write (tension_adapter.h, `publish`).
        char line[160];
        std::snprintf(line, sizeof(line),
                      "ogre: publish: guest_write refused (%d); the next epoch retries", wrote);
        log_line(2, line);
        return wrote;
    }
    s.status.clear_dirty();
    return 0;
}

int32_t adapter_shutdown(void *) {
    AdapterState &s = adapter_state();
    {
        std::lock_guard<std::mutex> lock(s.mutex);
        s.shutting_down = true;
    }
    const int32_t rc = stop_and_join(kJoinTimeoutMs);
    {
        std::lock_guard<std::mutex> lock(s.mutex);
        s.backend.reset();
        s.initialized = false;
        s.shutting_down = false;
    }
    return rc;
}

void adapter_destroy(void *) {
    // Nothing is heap-allocated at file scope: the state is a function-local
    // static and the backend died with its thread. Reset the flags so a second
    // load-then-link cycle (a test harness, a future re-init) starts clean.
    AdapterState &s = adapter_state();
    std::lock_guard<std::mutex> lock(s.mutex);
    s.backend.reset();
    s.api = nullptr;
    s.source_id = 0;
    s.initialized = false;
    s.shutting_down = false;
    s.stop_requested = false;
    s.thread_exited = false;
}

} // namespace

/// The backends' log sink, declared in backend.h.
void backend_log(const std::string &message) { log_line(1, message); }

AdapterState &adapter_state() {
    static AdapterState state;
    return state;
}

int32_t stop_and_join(uint32_t timeout_ms) {
    AdapterState &s = adapter_state();
    if (!s.thread.joinable()) return 0; // nothing started, or already joined

    s.stop_requested = true;
    s.cv.notify_all();

    {
        std::unique_lock<std::mutex> lock(s.mutex);
        const bool exited = s.cv.wait_for(lock, std::chrono::milliseconds(timeout_ms),
                                          [&s] { return s.thread_exited; });
        if (!exited) {
            char line[200];
            std::snprintf(line, sizeof(line),
                          "ogre: the render thread did not stop within %u ms; detaching it",
                          timeout_ms);
            log_line(3, line);
            s.thread.detach();
            s.initialized = false;
            s.stop_requested = false;
            return -EIO;
        }
    }
    // The thread has set its flag; joining now is a formality with a bound.
    s.thread.join();
    s.initialized = false;
    s.stop_requested = false;
    return 0;
}

} // namespace tension_ogre

extern "C" const tension_adapter *tension_adapter_v1(void) {
    using namespace tension_ogre;
    static const tension_adapter adapter = {
        TENSION_ADAPTER_ABI_VERSION, /* abi_version */
        "ogre",                      /* name: the wasm module this implements */
        0,                           /* flags: reserved */
        adapter_init,                /* init */
        adapter_link,                /* link */
        adapter_publish,             /* publish */
        nullptr,                     /* apply: no deferrable verb in this sub-chunk */
        adapter_shutdown,            /* shutdown */
        adapter_destroy,             /* destroy */
    };
    return &adapter;
}
