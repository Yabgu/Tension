// The input capability's adapter: the vtable, the six verb shims, and the one
// registration pass. Everything SDL-facing lives in src/input.cpp; this file is
// the ABI's edge and nothing else.
//
// The shape mirrors tension-ogre/src/adapter.cpp: a function-local static
// AdapterState (the host fills `ctx` with NULL on every vtable call, so there
// is no per-instance channel yet — SESSION.md §11 A4), a registration table
// walked in `link`, and shims that validate, delegate, and answer with a
// negative errno on refusal (rule 1).
//
// v0 owns no regions, so the vtable's `publish` is NULL — the header's "NULL
// means the adapter owns no regions". The state crosses through `input_state`
// instead (INPUT.md §3 Q3: the verb first, the region only when a consumer
// needs it from inside a callback).

#include "tension_adapter.h"
#include "tension_input.h"

#include "input.h"

#include <cerrno>
#include <cstdio>
#include <cstring>
#include <string>

namespace tension_input {
namespace {

/// The verb ids this adapter declares. Stable for the adapter's lifetime.
constexpr uint32_t kVerbOpen = 1;
constexpr uint32_t kVerbAttach = 2;
constexpr uint32_t kVerbSetRelative = 3;
constexpr uint32_t kVerbState = 4;
constexpr uint32_t kVerbPad = 5;
constexpr uint32_t kVerbClose = 6;

struct AdapterState {
    const tension_core_api *api = nullptr;
    uint32_t source_id = 0;
    InputThread thread;
    /// v0's declared capacity is one, so the handle is 1 or 0. The handle
    /// exists in the first version anyway: retrofitting one is the change the
    /// design's aspect table (INPUT.md §3 Q2) exists to avoid.
    int32_t handle = 0;
    bool attached = false;
};

AdapterState &adapter_state() {
    static AdapterState state;
    return state;
}

void log_line(int level, const char *message) {
    AdapterState &s = adapter_state();
    if (s.api != nullptr && s.api->log != nullptr && message != nullptr)
        s.api->log(s.api->user, level, message, static_cast<uint32_t>(std::strlen(message)));
}

} // namespace

/// One `[tension:input]` line; src/input.cpp calls this and does not own the log.
void input_log(const std::string &message) { log_line(1, message.c_str()); }

namespace {

// ── the six shims ───────────────────────────────────────────────────────

/// `input_open(flags) -> handle`. The subsystem is retried here, which is what
/// makes -ENODEV a state and not a verdict.
int32_t shim_input_open(void *, const tension_value *args, uint32_t nargs, tension_value *ret) {
    AdapterState &s = adapter_state();
    if (ret == nullptr || args == nullptr || nargs != 1) return -EINVAL;
    if (args[0].i32 != 0) return -EINVAL; /* no flags are defined yet */
    if (s.handle != 0) return -EBUSY;
    if (!s.thread.sdl_up()) {
        const int32_t retried = s.thread.retry_sdl();
        if (retried != 0 || !s.thread.sdl_up()) {
            log_line(1, "input: open: no SDL subsystem on this machine");
            return -ENODEV;
        }
    }
    s.handle = 1;
    ret->i32 = s.handle;
    return 0;
}

/// `input_attach(handle, kind, lo, hi)`. The request crosses to the SDL thread
/// and waits bounded for its answer, because the window call must run there.
int32_t shim_input_attach(void *, const tension_value *args, uint32_t nargs, tension_value *ret) {
    AdapterState &s = adapter_state();
    if (ret == nullptr || args == nullptr || nargs != 4) return -EINVAL;
    const int32_t handle = args[0].i32;
    const int32_t kind = args[1].i32;
    const uint32_t lo = static_cast<uint32_t>(args[2].i32);
    const uint32_t hi = static_cast<uint32_t>(args[3].i32);
    if (s.handle == 0 || handle != s.handle) return -EINVAL;
    if (kind < 0 || kind > 4) return -EINVAL;
    if (s.attached) return -EBUSY;

    const uint64_t token = (static_cast<uint64_t>(hi) << 32) | static_cast<uint64_t>(lo);
    const int32_t rc = s.thread.attach(static_cast<uint32_t>(kind), token);
    if (rc != 0) {
        log_line(1, ("input: attach refused (" + std::to_string(rc) + ")").c_str());
        return rc;
    }
    s.attached = true;
    ret->i32 = 0;
    return 0;
}

int32_t shim_input_set_relative(void *, const tension_value *args, uint32_t nargs,
                                tension_value *ret) {
    AdapterState &s = adapter_state();
    if (ret == nullptr || args == nullptr || nargs != 2) return -EINVAL;
    if (s.handle == 0 || args[0].i32 != s.handle) return -EINVAL;
    if (!s.attached) return -ENODEV;
    const int32_t rc = s.thread.set_relative(args[1].i32 != 0);
    if (rc != 0) return rc;
    ret->i32 = 0;
    return 0;
}

int32_t shim_input_state(void *, const tension_value *args, uint32_t nargs, tension_value *ret) {
    AdapterState &s = adapter_state();
    if (ret == nullptr || args == nullptr || nargs != 3) return -EINVAL;
    if (s.handle == 0 || args[0].i32 != s.handle) return -EINVAL;
    if (!s.attached) return -ENODEV;
    const uint32_t ptr = static_cast<uint32_t>(args[1].i32);
    const int32_t cap = args[2].i32;
    if (cap <= 0) { /* the probe: the size, nothing written */
        ret->i32 = static_cast<int32_t>(TENSION_INPUT_STATE_SIZE);
        return 0;
    }
    if (static_cast<uint32_t>(cap) < TENSION_INPUT_STATE_SIZE) return -ENOSPC;
    if (s.api == nullptr || s.api->guest_write == nullptr) return -EBUSY;

    StateRecord record = {};
    s.thread.snapshot(&record);
    if (s.api->guest_write(s.api->user, ptr, &record, sizeof(record)) != 0) return -EINVAL;
    ret->i32 = static_cast<int32_t>(TENSION_INPUT_STATE_SIZE);
    return 0;
}

int32_t shim_input_pad(void *, const tension_value *args, uint32_t nargs, tension_value *ret) {
    AdapterState &s = adapter_state();
    if (ret == nullptr || args == nullptr || nargs != 4) return -EINVAL;
    if (s.handle == 0 || args[0].i32 != s.handle) return -EINVAL;
    if (!s.attached) return -ENODEV;
    const int32_t slot = args[1].i32;
    if (slot < 0 || slot >= static_cast<int32_t>(TENSION_INPUT_PAD_SLOTS)) return -EINVAL;
    const uint32_t ptr = static_cast<uint32_t>(args[2].i32);
    const int32_t cap = args[3].i32;
    if (cap <= 0) {
        ret->i32 = static_cast<int32_t>(TENSION_INPUT_PAD_SIZE);
        return 0;
    }
    if (static_cast<uint32_t>(cap) < TENSION_INPUT_PAD_SIZE) return -ENOSPC;

    PadRecord record = {};
    if (!s.thread.pad(static_cast<uint32_t>(slot), &record)) return -ENOENT; /* no pad is normal */
    if (s.api == nullptr || s.api->guest_write == nullptr) return -EBUSY;
    if (s.api->guest_write(s.api->user, ptr, &record, sizeof(record)) != 0) return -EINVAL;
    ret->i32 = static_cast<int32_t>(TENSION_INPUT_PAD_SIZE);
    return 0;
}

int32_t shim_input_close(void *, const tension_value *args, uint32_t nargs, tension_value *ret) {
    AdapterState &s = adapter_state();
    if (ret == nullptr || args == nullptr || nargs != 1) return -EINVAL;
    if (s.handle == 0 || args[0].i32 != s.handle) return -EINVAL;
    if (s.attached) {
        const int32_t rc = s.thread.detach();
        if (rc != 0) {
            log_line(2, ("input: close: detach answered " + std::to_string(rc)).c_str());
            return rc;
        }
        s.attached = false;
    }
    s.handle = 0;
    /* The SDL subsystem stays up: it is the process-scoped aspect, and the next
       open inherits it (INPUT.md §3 Q2). */
    ret->i32 = 0;
    return 0;
}

// ── the vtable ───────────────────────────────────────────────────────────

int32_t adapter_init(void *, const tension_core_api *core) {
    if (core == nullptr || core->abi_version != TENSION_ADAPTER_ABI_VERSION) return -EINVAL;
    AdapterState &s = adapter_state();
    s.api = core;
    s.handle = 0;
    s.attached = false;
    // The thread is created here and its first act is SDL_Init. Its return says
    // whether the *thread* came up: "no display" is NOT a load failure — the
    // refusal point is input_open/attach, which can be retried (INPUT.md §4).
    const int32_t rc = s.thread.start();
    if (rc != 0) {
        log_line(3, "input: init: the SDL thread did not start");
        return rc;
    }
    const std::string line = "input: init: SDL thread up, video driver '" + s.thread.driver() + "'";
    log_line(1, line.c_str());
    return 0;
}

int32_t adapter_link(void *, const tension_core_api *core) {
    AdapterState &s = adapter_state();
    if (core == nullptr) return -EINVAL;

    const uint32_t i32 = TENSION_VT_I32;
    const uint32_t one[1] = {i32};
    const uint32_t two[2] = {i32, i32};
    const uint32_t three[3] = {i32, i32, i32};
    const uint32_t four[4] = {i32, i32, i32, i32};

    struct Registration {
        const char *name;
        const uint32_t *params;
        uint32_t nparams;
        tension_import_fn fn;
        uint32_t verb_id;
        uint32_t flags;
    };
    const Registration registrations[] = {
        {"open", one, 1, shim_input_open, kVerbOpen, 0},
        {"attach", four, 4, shim_input_attach, kVerbAttach, 0},
        {"set_relative", two, 2, shim_input_set_relative, kVerbSetRelative, 0},
        // The two readers are exempt accessors: they take a snapshot and write
        // guest memory, never pumping and never blocking (the `job_state` case).
        {"state", three, 3, shim_input_state, kVerbState, TENSION_IMPORT_REENTRANT_READONLY},
        {"pad", four, 4, shim_input_pad, kVerbPad, TENSION_IMPORT_REENTRANT_READONLY},
        {"close", one, 1, shim_input_close, kVerbClose, 0},
    };

    for (const Registration &registration : registrations) {
        const int32_t rc = core->register_import(core->user, "tension::input", registration.name,
                                                 TENSION_VT_I32, registration.params,
                                                 registration.nparams, registration.fn, nullptr,
                                                 registration.verb_id, registration.flags);
        if (rc != 0) {
            const std::string line =
                std::string("input: link: registering `") + registration.name + "` refused (" +
                std::to_string(rc) + ")";
            log_line(3, line.c_str());
            return rc;
        }
    }

    uint32_t source_id = 0;
    const int32_t sourced = core->register_source(core->user, "tension::input", 0, &source_id);
    if (sourced != 0) {
        log_line(3, "input: link: register_source refused");
        return sourced;
    }
    s.source_id = source_id;
    // The thread may already be pumping; the poster becomes visible to it here.
    s.thread.set_poster(core, source_id);
    return 0;
}

int32_t adapter_shutdown(void *) {
    AdapterState &s = adapter_state();
    // Stop the thread (SDL_Quit runs on it), release the handle. Idempotent.
    s.thread.stop();
    s.handle = 0;
    s.attached = false;
    return 0;
}

void adapter_destroy(void *) {
    // The state is a function-local static; there is nothing the adapter owns
    // that shutdown has not already released.
}

} // namespace

} // namespace tension_input

extern "C" const tension_adapter *tension_adapter_v1(void) {
    using namespace tension_input;
    static const tension_adapter adapter = {
        TENSION_ADAPTER_ABI_VERSION, /* abi_version */
        "tension::input",            /* name: the wasm module this implements */
        0,                           /* flags: reserved */
        adapter_init,                /* init */
        adapter_link,                /* link */
        nullptr,                     /* publish: v0 owns no regions */
        nullptr,                     /* apply: no deferrable verb */
        adapter_shutdown,            /* shutdown */
        adapter_destroy,             /* destroy */
    };
    return &adapter;
}
