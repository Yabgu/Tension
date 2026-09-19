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
#include <cstring>
#include <exception>
#include <string>

#include "../include/tension_ogre.h"
#include "backend.h"

namespace tension_ogre {
namespace {

/// The verb ids this adapter declares. They are stable for the adapter's
/// lifetime and are what `apply` would be handed, once a verb is deferrable.
constexpr uint32_t kVerbInit = 1;
constexpr uint32_t kVerbShutdown = 2;
constexpr uint32_t kVerbLastError = 3;

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
            fail(TENSION_OGRE_STAGE_PLUGIN, -ENOSYS,
                 "no backend for the requested renderer (this build has no OGRE-Next)");
            finish_thread();
            return;
        }

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
            const int32_t framed = s.backend->frame(s.status);
            if (framed != 0) {
                fail(TENSION_OGRE_STAGE_FRAME, framed, "a frame failed");
                break;
            }
            std::unique_lock<std::mutex> lock(s.mutex);
            // Bounded wait, so a stop request is honoured immediately and an
            // idle loop does not spin.
            s.cv.wait_for(lock, period, [&s] { return s.stop_requested.load(); });
        }
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
    const uint32_t two_i32[2] = {i32, i32};

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
    return 0;
}

/// The publish hook: the render thread's mirror, copied into the renderer's
/// `Resource` record. This is the only place this adapter writes guest memory.
int32_t adapter_publish(void *, const tension_core_api *core) {
    AdapterState &s = adapter_state();
    if (!s.status.dirty()) return 0; // nothing to say: no API needed, no budget spent
    if (core == nullptr || core->guest_write == nullptr) return -EINVAL;
    if (s.resource_size < TENSION_OGRE_RESOURCE_RECORD_BYTES) {
        log_line(3, "ogre: publish: the RESOURCE region is smaller than one record");
        return -ENOENT;
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
