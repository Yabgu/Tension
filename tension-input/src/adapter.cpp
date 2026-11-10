// The input capability's adapter: the vtable, the six verb shims, the layer
// subscription, and the one registration pass.
//
// Nothing SDL-facing is left anywhere in this DSO. Before v7 this file's `init`
// started a thread whose first act was `SDL_Init`, and every verb that needed a
// window crossed to that thread and waited for its answer. The host owns all of
// that now (tension_adapter.h, thread rule 13), so what is left is an ABI edge:
// validate, ask the host through the slots, answer with a negative errno on
// refusal (rule 1).
//
// The two host calls this file makes are `register_event_layer` (once, in
// `init`) and `host_window_info` / `pad_state` / `post_control` (from the
// verbs). It never sees a window handle, which is the point: there is no window
// for it to see.

#include "tension_adapter.h"
#include "tension_input.h"

#include "input.h"

#include <cerrno>
#include <cstdio>
#include <cstring>
#include <string>

namespace tension_input {
namespace {

constexpr int32_t kENODEV = -19; /* no display, no window, nothing attached */
constexpr int32_t kENOENT = -2;  /* no such window token, or an empty pad slot */
constexpr int32_t kENOSYS = -38; /* a host that does not serve pad state */
constexpr int32_t kENOSPC = -28; /* a short buffer */
constexpr int32_t kEBUSY = -16;  /* the capacity is taken, or already attached */

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
    Mirror mirror;
    /// v0's declared capacity is one, so the handle is 1 or 0. The handle
    /// exists in the first version anyway: a guest that holds one cannot be
    /// retrofitted into a guest that does not, and the six-verb wire is fixed
    /// (`docs/modules/input.md` §2).
    int32_t handle = 0;
    /// The token `register_event_layer` handed back, or nullptr. One layer per
    /// process: a second registration would double every edge this capability
    /// posts, because both layers would see the same events.
    void *layer_user = nullptr;
};

AdapterState &adapter_state() {
    static AdapterState state;
    return state;
}

/// Answer a refusal so the *guest* sees it.
///
/// The session puts `ret` into the wasm result slot and only logs the shim's
/// return value as a status (tension-core/src/adapter/ffi.rs: `let mut ret =
/// TensionValue::zero(); ... results[0] = val_of_tension(ret)`, then
/// `if status != 0 { log_line(...) }`). So a `return -ENOENT;` that leaves
/// `ret` alone answers the guest 0 — measured by this capability's own fixture,
/// which saw `pad(0)` answer 0 while the session logged `adapter status -2`.
/// Every refusal therefore writes both.
int32_t refuse(tension_value *ret, int32_t errno_value) {
    if (ret != nullptr) ret->i32 = errno_value;
    return errno_value;
}

/// The legacy `log` level (0 debug, 1 info, 2 warning, 3 error) as its
/// `tension_log_level_t` equivalent (1 DEBUG, 2 INFO, 3 WARN, 4 ERROR).
constexpr int32_t named_level(int32_t legacy) {
    return legacy <= 0 ? 1 : legacy == 1 ? 2 : legacy == 2 ? 3 : 4;
}

/// One line on the `input` logger.
///
/// Prefers the appended `log_named` slot, which carries the logger name, so the
/// host's per-logger filtering (`--log-level=input:debug`) reaches these lines
/// and the host applies its configured layout. A host that left the slot NULL
/// falls back to the legacy `log` slot, which stays populated under rule 11.
void log_line(int level, const char *message) {
    AdapterState &s = adapter_state();
    if (s.api == nullptr || message == nullptr) return;
    const uint32_t len = static_cast<uint32_t>(std::strlen(message));
    if (s.api->log_named != nullptr) {
        s.api->log_named(s.api->user, named_level(level), "input", message, len);
        return;
    }
    if (s.api->log != nullptr) s.api->log(s.api->user, level, message, len);
}

/// `host_window_info`, or a zeroed record for "no window".
///
/// The host answers 0 with a zeroed record rather than -ENODEV, so `width > 0`
/// is the whole test — the same one a guest makes. -ENOSYS means a host built
/// without the platform module, which is a host with no window either.
bool host_has_window(tension_window_info *out) {
    AdapterState &s = adapter_state();
    if (s.api == nullptr || s.api->host_window_info == nullptr) return false;
    tension_window_info info = {};
    info.struct_size = sizeof(info);
    if (s.api->host_window_info(s.api->user, &info) != 0) return false;
    if (out != nullptr) *out = info;
    return info.struct_size != 0 && info.width > 0;
}

/// The capability's only SDL-shaped request: the host's executor performs it.
int32_t post_relative_mouse(bool on) {
    AdapterState &s = adapter_state();
    if (s.api == nullptr || s.api->post_control == nullptr) return kENOSYS;
    tension_ctrl_msg msg = {};
    msg.kind = TENSION_CTRL_RELATIVE_MOUSE;
    // `CORE_ONLY`: the guest learns the result from `input_state`'s RELATIVE
    // flag, not from `host_surface`.
    msg.visibility = TENSION_CTRL_CORE_ONLY;
    msg.arg0 = on ? 1 : 0;
    const int32_t rc = s.api->post_control(s.api->user, &msg);
    if (rc == 0) return 0;
    // The queue is full, which is a "try later", not a permanent refusal. The
    // guest's vocabulary has no -EAGAIN and this is the closest honest word.
    return rc == kENOSPC ? kEBUSY : rc;
}

/// One gamepad slot from the host's mirror. Returns the host's errno unchanged:
/// 0 with `out` filled, -ENODEV for an empty slot, -ENOSYS for a host that does
/// not serve pads.
int32_t read_pad_state(uint32_t slot, PadRecord *out) {
    AdapterState &s = adapter_state();
    if (s.api == nullptr || s.api->pad_state == nullptr) return kENOSYS;
    return s.api->pad_state(s.api->user, slot, out);
}

/// The layer's `dispatch`: one batch, on the host's thread, synchronously after
/// the pump (thread rule 13).
///
/// It returns 0 — "consumed" — always. A non-zero return would be logged once by
/// the host and must never fail a frame; there is no partial failure here to
/// report, because ingesting an event cannot fail: an unknown family is skipped
/// and an out-of-range scancode is dropped by the mirror.
int32_t dispatch_events(void *, const tension_event *events, uint32_t count) {
    adapter_state().mirror.ingest(events, count, now_ms());
    return 0;
}

/// Nothing to do at teardown: the host has already stopped dispatching, and the
/// adapter's own `shutdown` unregisters. Present so the layer struct has a
/// truthful `shutdown` rather than a NULL it would have to document.
void dispatch_shutdown(void *) {}

} // namespace

/// One line on the `input` logger; src/input.cpp calls this and does not own
/// the log.
void input_log(const std::string &message) { log_line(1, message.c_str()); }

namespace {

// ── the six shims ───────────────────────────────────────────────────────

/// `input_open(flags) -> handle`.
///
/// No device is opened here any more, so nothing can fail for want of a display:
/// "no window" is a state the *attach* reports, which is what makes a later
/// attach work once the guest has created one. That ordering is v7's rule —
/// `createWindow`, then `input.open`, then `input.attach`.
int32_t shim_input_open(void *, const tension_value *args, uint32_t nargs, tension_value *ret) {
    AdapterState &s = adapter_state();
    if (ret == nullptr || args == nullptr || nargs != 1) return -EINVAL;
    if (args[0].i32 != 0) return refuse(ret, -EINVAL); /* no flags are defined yet */
    if (s.handle != 0) return refuse(ret, -EBUSY);
    s.handle = 1;
    ret->i32 = s.handle;
    return 0;
}

/// `input_attach(handle, kind, lo, hi)`.
///
/// The four-argument wire is unchanged and `kind`/`lo`/`hi` are **ignored**: the
/// guest no longer names a surface, because there is only one — the host's
/// window — and the capability joins it by subscribing. A token that names an
/// X11 window or an HWND has nothing left to attach to.
///
/// `-ENODEV` when the host owns no window yet, which is the state a guest is in
/// before `platform.createWindow`. `-EBUSY` on a second attach.
int32_t shim_input_attach(void *, const tension_value *args, uint32_t nargs, tension_value *ret) {
    AdapterState &s = adapter_state();
    if (ret == nullptr || args == nullptr || nargs != 4) return -EINVAL;
    const int32_t handle = args[0].i32;
    const int32_t kind = args[1].i32;
    if (s.handle == 0 || handle != s.handle) return refuse(ret, -EINVAL);
    if (kind < 0 || kind > 4) return refuse(ret, -EINVAL);
    if (s.mirror.attached()) return refuse(ret, kEBUSY);
    if (!host_has_window(nullptr)) {
        log_line(1, "input: attach: the host owns no window (create one first)");
        return refuse(ret, kENODEV);
    }
    s.mirror.attach(now_ms());
    log_line(1, "input: attached to the host's window; discarding 500 ms of settling motion");
    ret->i32 = 0;
    return 0;
}

/// `input_set_relative(handle, on)`.
///
/// Posts `TENSION_CTRL_RELATIVE_MOUSE` and returns once the request is *queued*,
/// not once it is applied: the executor runs in the host's loop. The RELATIVE
/// flag in `input_state` therefore reflects the request the host accepted, and
/// the host logs any refusal at the moment it tries.
int32_t shim_input_set_relative(void *, const tension_value *args, uint32_t nargs,
                                tension_value *ret) {
    AdapterState &s = adapter_state();
    if (ret == nullptr || args == nullptr || nargs != 2) return -EINVAL;
    if (s.handle == 0 || args[0].i32 != s.handle) return refuse(ret, -EINVAL);
    if (!s.mirror.attached()) return refuse(ret, kENODEV);
    const bool on = args[1].i32 != 0;
    const int32_t rc = post_relative_mouse(on);
    if (rc != 0) {
        log_line(2, ("input: set_relative could not be queued (" + std::to_string(rc) + ")").c_str());
        return refuse(ret, rc);
    }
    s.mirror.set_relative(on);
    ret->i32 = 0;
    return 0;
}

int32_t shim_input_state(void *, const tension_value *args, uint32_t nargs, tension_value *ret) {
    AdapterState &s = adapter_state();
    if (ret == nullptr || args == nullptr || nargs != 3) return -EINVAL;
    if (s.handle == 0 || args[0].i32 != s.handle) return refuse(ret, -EINVAL);
    if (!s.mirror.attached()) return refuse(ret, kENODEV);
    const uint32_t ptr = static_cast<uint32_t>(args[1].i32);
    const int32_t cap = args[2].i32;
    if (cap <= 0) { /* the probe: the size, nothing written */
        ret->i32 = static_cast<int32_t>(TENSION_INPUT_STATE_SIZE);
        return 0;
    }
    if (static_cast<uint32_t>(cap) < TENSION_INPUT_STATE_SIZE) return refuse(ret, kENOSPC);
    if (s.api == nullptr || s.api->guest_write == nullptr) return refuse(ret, kEBUSY);

    // Which slots have a pad is the host's fact, not this capability's: the
    // layer is told about hotplug as an event but does not own the slot map, so
    // it asks. One slot record per slot, from the host's mirror — no SDL call,
    // no allocation.
    uint32_t pads_present = 0;
    for (uint32_t slot = 0; slot < TENSION_INPUT_PAD_SLOTS; ++slot) {
        PadRecord record = {};
        if (read_pad_state(slot, &record) == 0) pads_present |= (1u << slot);
    }

    StateRecord record = {};
    s.mirror.snapshot(&record, pads_present);
    if (s.api->guest_write(s.api->user, ptr, &record, sizeof(record)) != 0)
        return refuse(ret, -EINVAL);
    ret->i32 = static_cast<int32_t>(TENSION_INPUT_STATE_SIZE);
    return 0;
}

int32_t shim_input_pad(void *, const tension_value *args, uint32_t nargs, tension_value *ret) {
    AdapterState &s = adapter_state();
    if (ret == nullptr || args == nullptr || nargs != 4) return -EINVAL;
    if (s.handle == 0 || args[0].i32 != s.handle) return refuse(ret, -EINVAL);
    if (!s.mirror.attached()) return refuse(ret, kENODEV);
    const int32_t slot = args[1].i32;
    if (slot < 0 || slot >= static_cast<int32_t>(TENSION_INPUT_PAD_SLOTS)) return refuse(ret, -EINVAL);
    const uint32_t ptr = static_cast<uint32_t>(args[2].i32);
    const int32_t cap = args[3].i32;
    if (cap <= 0) {
        ret->i32 = static_cast<int32_t>(TENSION_INPUT_PAD_SIZE);
        return 0;
    }
    if (static_cast<uint32_t>(cap) < TENSION_INPUT_PAD_SIZE) return refuse(ret, kENOSPC);

    PadRecord record = {};
    const int32_t rc = read_pad_state(static_cast<uint32_t>(slot), &record);
    if (rc == kENODEV) return refuse(ret, kENOENT); /* no pad is normal, not a failure */
    if (rc != 0) return refuse(ret, rc);
    if (s.api == nullptr || s.api->guest_write == nullptr) return refuse(ret, kEBUSY);
    if (s.api->guest_write(s.api->user, ptr, &record, sizeof(record)) != 0)
        return refuse(ret, -EINVAL);
    ret->i32 = static_cast<int32_t>(TENSION_INPUT_PAD_SIZE);
    return 0;
}

int32_t shim_input_close(void *, const tension_value *args, uint32_t nargs, tension_value *ret) {
    AdapterState &s = adapter_state();
    if (ret == nullptr || args == nullptr || nargs != 1) return -EINVAL;
    if (s.handle == 0 || args[0].i32 != s.handle) return refuse(ret, -EINVAL);
    s.mirror.detach();
    s.handle = 0;
    ret->i32 = 0;
    return 0;
}

// ── the vtable ───────────────────────────────────────────────────────────

int32_t adapter_init(void *, const tension_core_api *core) {
    if (core == nullptr || core->abi_version != TENSION_ADAPTER_ABI_VERSION) return -EINVAL;
    AdapterState &s = adapter_state();
    s.api = core;
    s.handle = 0;
    s.mirror.detach();

    // Subscribe to the host's events. This is `init` and not `link` because it
    // is the capability's own device, not a name the guest imports: the host may
    // pump before `link` runs, and an event lost in that window would be an edge
    // the guest never sees.
    if (s.layer_user == nullptr) {
        if (core->register_event_layer == nullptr) {
            log_line(3, "input: init: this host has no event dispatcher (ABI < 7)");
            return kENOSYS;
        }
        tension_event_layer layer = {};
        layer.struct_size = sizeof(layer);
        // Everything but QUIT: the host owns quit, and a layer that cannot stop
        // the loop has no use for it. WINDOW is here for focus and pointer
        // enter/leave, which are state this capability reports.
        layer.event_mask = TENSION_EVENT_KEY | TENSION_EVENT_TEXT | TENSION_EVENT_MOUSE_MOTION |
                           TENSION_EVENT_MOUSE_BUTTON | TENSION_EVENT_MOUSE_WHEEL |
                           TENSION_EVENT_WINDOW | TENSION_EVENT_PAD;
        layer.dispatch = dispatch_events;
        layer.shutdown = dispatch_shutdown;
        void *layer_user = nullptr;
        const int32_t rc = core->register_event_layer(core->user, &layer, &layer_user);
        if (rc != 0) {
            log_line(3, ("input: init: register_event_layer refused (" + std::to_string(rc) + ")").c_str());
            return rc;
        }
        s.layer_user = layer_user;
    }
    log_line(1, "input: init: subscribed to the host's events (layer)");
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
    // The dispatcher may already have delivered a batch by now; the poster
    // becoming visible here is what makes the next one's edges land.
    s.mirror.set_poster(core, source_id);
    return 0;
}

/// The host's one teardown call.
///
/// `shutdown` then `destroy`, reverse of link order, once each, on both exit
/// paths — a clean return and a guest trap (`tension-core/src/adapter/mod.rs`,
/// `LoadedAdapter::teardown`, and `main.rs`'s two calls). It runs on the
/// interpreter thread, outside any guest call, and the library is `dlclose`d
/// after it.
///
/// There is no thread here to join and no SDL state to release: the only
/// host-side object this capability owns is its event layer, and unregistering
/// it is the whole job. `SDL_Quit` belongs to the host's `Sdl` and is never
/// called from an adapter (`INPUT.md` §5). Idempotent — a second call finds no
/// layer and a detached mirror.
int32_t adapter_shutdown(void *) {
    AdapterState &s = adapter_state();
    // Unsubscribe *before* anything else: the host tears its layers down after
    // the adapters (main.rs's teardown order), and a layer left registered would
    // be a call into code the loader is about to unmap.
    if (s.layer_user != nullptr && s.api != nullptr && s.api->unregister_event_layer != nullptr) {
        const int32_t rc = s.api->unregister_event_layer(s.api->user, s.layer_user);
        if (rc != 0) {
            log_line(2, ("input: shutdown: unregister refused (" + std::to_string(rc) + ")").c_str());
        }
        s.layer_user = nullptr;
    }
    s.mirror.detach();
    s.handle = 0;
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
        TENSION_ADAPTER_LAYOUT_HASH, /* layout_hash: the arena layout this was built against */
    };
    return &adapter;
}
