/*
 * tension-2d's adapter: the vtable, the ten verb shims, and the one
 * registration pass.
 *
 * The shape is tension-input/src/adapter.cpp's, field for field: a
 * function-local static state, a registration table walked in `link`, shims
 * that validate, delegate and answer with a negative errno on refusal, and a
 * vtable whose `publish` and `apply` are NULL because this capability owns no
 * regions and has no deferrable verb (`docs/modules/2d.md` §1).
 *
 * Everything SDL-facing lives in render.cpp; everything colour-space-facing
 * lives in texture.cpp. This file is the ABI's edge and nothing else — which is
 * why it includes no SDL header.
 *
 * SPDX-License-Identifier: MIT
 */

#include "tension_adapter.h"
#include "tension_2d.h"

#include "render.h"

#include <cerrno>
#include <cstring>
#include <map>
#include <string>
#include <vector>

namespace tension_2d {
namespace {

/// The verb ids this adapter declares. Stable for the adapter's lifetime.
constexpr uint32_t kVerbOpen = 1;
constexpr uint32_t kVerbClose = 2;
constexpr uint32_t kVerbSetPipeline = 3;
constexpr uint32_t kVerbShaderCompileRaw = 4;
constexpr uint32_t kVerbSubmit = 5;
constexpr uint32_t kVerbPresent = 6;
constexpr uint32_t kVerbTextureLoad = 7;
constexpr uint32_t kVerbInfo = 8;
constexpr uint32_t kVerbScreenshot = 9;
constexpr uint32_t kVerbSetTexture = 10;

struct AdapterState {
    const tension_core_api *api = nullptr;
    Renderer renderer;
    /// Capacity is one and the handle is 1 or 0. It exists in the first version
    /// anyway: retrofitting a handle is the change an aspect table exists to
    /// avoid (the same reasoning as tension-input's `input_open`).
    int32_t handle = 0;
    /// Runtime-compiled pipelines, keyed by blob hash. Without this a guest
    /// that re-sets the same graph would compile it again — 30 ms each, and a
    /// new pipeline object every time.
    std::map<uint64_t, uint32_t> runtime_pipes;
};

AdapterState &adapter_state() {
    static AdapterState state;
    return state;
}

/// Answer a refusal so the *guest* sees it.
///
/// The session puts `ret` into the wasm result slot and only logs the shim's
/// return as a status (tension-core/src/adapter/ffi.rs), so a `return -ENOENT;`
/// that leaves `ret` alone answers the guest 0. Every refusal writes both.
int32_t refuse(tension_value *ret, int32_t errno_value) {
    if (ret != nullptr) ret->i32 = errno_value;
    return errno_value;
}

int32_t answer(tension_value *ret, int32_t value) {
    if (ret != nullptr) ret->i32 = value;
    return 0;
}

/// One line on the `2d` logger, preferring the appended `log_named` slot so the
/// host's per-logger filtering and layout reach it.
void log_line(int32_t legacy_level, const char *message) {
    const tension_core_api *api = adapter_state().api;
    if (api == nullptr) return;
    const int32_t named = legacy_level <= 0 ? 1 : legacy_level == 1 ? 2 : legacy_level == 2 ? 3 : 4;
    const uint32_t len = static_cast<uint32_t>(std::strlen(message));
    if (api->log_named != nullptr) {
        api->log_named(api->user, named, "2d", message, len);
    } else if (api->log != nullptr) {
        api->log(api->user, legacy_level, message, len);
    }
}

/// A guest pointer plus its length, as the shims want it.
struct GuestSpan {
    uint32_t ptr;
    uint32_t len;
};

/// Copy `span` out of guest memory. Returns 0 or the `guest_read` refusal.
int32_t read_guest(const GuestSpan &span, std::vector<uint8_t> &out) {
    const tension_core_api *api = adapter_state().api;
    if (api == nullptr || api->guest_read == nullptr) return -EBADF;
    if (span.len == 0) return -EINVAL;
    out.resize(span.len);
    const int32_t rc = api->guest_read(api->user, span.ptr, out.data(), span.len);
    if (rc != 0) out.clear();
    return rc;
}

int32_t write_guest(uint32_t ptr, uint32_t cap, const void *src, uint32_t len) {
    const tension_core_api *api = adapter_state().api;
    if (api == nullptr || api->guest_write == nullptr) return -EBADF;
    if (len > cap) return -ENOSPC;
    return api->guest_write(api->user, ptr, src, len);
}

// ── the ten shims ────────────────────────────────────────────────────────

int32_t shim_open(void *, const tension_value *args, uint32_t nargs, tension_value *ret) {
    if (nargs != 3) return refuse(ret, -EINVAL);
    const int32_t width = args[0].i32;
    const int32_t height = args[1].i32;
    const int32_t flags = args[2].i32;
    if ((flags & ~static_cast<int32_t>(TENSION_2D_OPEN_WINDOWED)) != 0) {
        return refuse(ret, -EINVAL);
    }
    if (width <= 0 || height <= 0) return refuse(ret, -EINVAL);

    AdapterState &state = adapter_state();
    if (state.handle != 0) return refuse(ret, -EBUSY);

    std::string err;
    const int32_t rc = state.renderer.open(static_cast<uint32_t>(width),
                                           static_cast<uint32_t>(height),
                                           (flags & TENSION_2D_OPEN_WINDOWED) != 0, err);
    if (rc != 0) {
        const std::string line = "2d: open refused (" + err + ")";
        log_line(3, line.c_str());
        return refuse(ret, rc);
    }
    state.handle = 1;
    const std::string line = "2d: open: GPU device up, " +
                             std::string((flags & TENSION_2D_OPEN_WINDOWED) ? "window " : "offscreen ") +
                             std::to_string(width) + "x" + std::to_string(height) + " target";
    log_line(1, line.c_str());
    return answer(ret, state.handle);
}

int32_t shim_close(void *, const tension_value *args, uint32_t nargs, tension_value *ret) {
    if (nargs != 1) return refuse(ret, -EINVAL);
    AdapterState &state = adapter_state();
    if (args[0].i32 != state.handle || state.handle == 0) return refuse(ret, -EINVAL);
    state.renderer.close();
    state.handle = 0;
    log_line(1, "2d: close: device released");
    return answer(ret, 0);
}

int32_t shim_set_pipeline(void *, const tension_value *args, uint32_t nargs, tension_value *ret) {
    if (nargs != 3) return refuse(ret, -EINVAL);
    AdapterState &state = adapter_state();
    if (args[0].i32 != state.handle || state.handle == 0) return refuse(ret, -EINVAL);

    const int32_t blob_ptr = args[1].i32;
    const int32_t blob_len = args[2].i32;

    if (blob_ptr != 0) {
        // A serialized graph. The renderer resolves it to the module pair the
        // build compiled from that graph (`scripts/build-2d.mjs`), which is why
        // it can answer with a real pipe_id instead of -ENOSYS.
        if (blob_len <= 0) return refuse(ret, -EINVAL);
        std::vector<uint8_t> blob;
        if (const int32_t rc = read_guest({static_cast<uint32_t>(blob_ptr),
                                           static_cast<uint32_t>(blob_len)},
                                          blob);
            rc != 0) {
            return refuse(ret, rc == -ENOSPC ? -EINVAL : rc);
        }
        uint32_t graph_pipe = 0;
        std::string err;
        int32_t rc = state.renderer.set_pipeline_blob(blob.data(), blob.size(), graph_pipe, err);

        const uint64_t hash = graph_hash(blob.data(), blob.size());
        auto cached = state.runtime_pipes.find(hash);
        if (cached != state.runtime_pipes.end()) {
            return answer(ret, static_cast<int32_t>(cached->second));
        }

        if (rc == -ENOSYS && state.api != nullptr && state.api->compile_graph != nullptr) {
            // Not a graph this build shipped. Ask the host to compile it: the
            // core owns the compiler, this DSO owns the device, and neither
            // carries the other's dependency (rule 8).
            //
            // Two calls: the first learns the sizes, the second transfers. The
            // slot reports `-ENOSPC` with the sizes filled in, so a retry needs
            // no probing heuristic.
            uint32_t vs_len = 0;
            uint32_t fs_len = 0;
            const int32_t sized = state.api->compile_graph(state.api->user, blob.data(),
                                                           static_cast<uint32_t>(blob.size()),
                                                           nullptr, 0, nullptr, 0, &vs_len, &fs_len);
            if (sized != -ENOSPC) {
                const std::string line =
                    "2d: set_pipeline: host compile failed (" + std::to_string(sized) + ")";
                log_line(3, line.c_str());
                return refuse(ret, sized == 0 ? -EIO : sized);
            }

            std::vector<uint8_t> vs(vs_len);
            std::vector<uint8_t> fs(fs_len);
            uint32_t vs_got = 0;
            uint32_t fs_got = 0;
            const int32_t compiled = state.api->compile_graph(
                state.api->user, blob.data(), static_cast<uint32_t>(blob.size()), vs.data(), vs_len,
                fs.data(), fs_len, &vs_got, &fs_got);
            if (compiled != 0) {
                const std::string line =
                    "2d: set_pipeline: host compile refused (" + std::to_string(compiled) + ")";
                log_line(3, line.c_str());
                return refuse(ret, compiled);
            }
            rc = state.renderer.set_pipeline_spirv(vs.data(), vs_got, fs.data(), fs_got,
                                                   graph_pipe, err);
            if (rc == 0) state.runtime_pipes[hash] = graph_pipe;
        }

        if (rc != 0) {
            const std::string line = "2d: set_pipeline refused (" + err + ")";
            log_line(3, line.c_str());
            return refuse(ret, rc);
        }
        log_line(1, ("2d: set_pipeline: graph blob -> pipe " + std::to_string(graph_pipe)).c_str());
        return answer(ret, static_cast<int32_t>(graph_pipe));
    }
    if (blob_len < TENSION_2D_PIPE_PRESET_MIN || blob_len > TENSION_2D_PIPE_PRESET_MAX) {
        return refuse(ret, -ENOENT);
    }

    uint32_t pipe_id = 0;
    std::string err;
    const int32_t rc = state.renderer.set_pipeline(static_cast<uint16_t>(blob_len), pipe_id, err);
    if (rc != 0) {
        const std::string line = "2d: set_pipeline refused (" + err + ")";
        log_line(3, line.c_str());
        return refuse(ret, rc);
    }
    return answer(ret, static_cast<int32_t>(pipe_id));
}

int32_t shim_shader_compile_raw(void *, const tension_value *, uint32_t nargs,
                                tension_value *ret) {
    if (nargs != 5) return refuse(ret, -EINVAL);
    // The wire has the door; the build has no GLSL -> SPIR-V translator linked
    // into the DSO (`docs/modules/2d.md` §4). An honest -ENOSYS beats a half-door.
    log_line(2, "2d: shader_compile_raw: no shader translator in this build");
    return refuse(ret, -ENOSYS);
}

int32_t shim_submit(void *, const tension_value *args, uint32_t nargs, tension_value *ret) {
    if (nargs != 4) return refuse(ret, -EINVAL);
    AdapterState &state = adapter_state();
    if (args[0].i32 != state.handle || state.handle == 0) return refuse(ret, -EINVAL);

    const int32_t pipe_id = args[1].i32;
    const uint32_t hdr_ptr = static_cast<uint32_t>(args[2].i32);
    const int32_t bucket = args[3].i32;

    // One read for the header, one for the array: the guest pointer is not kept
    // past this call (tension_adapter.h rule 6).
    std::vector<uint8_t> header;
    if (const int32_t rc = read_guest({hdr_ptr, sizeof(tension_2d_submit_hdr)}, header); rc != 0) {
        return refuse(ret, rc == -ENOSPC ? -EINVAL : rc);
    }
    tension_2d_submit_hdr hdr;
    std::memcpy(&hdr, header.data(), sizeof hdr);

    if (hdr.flags != 0) return refuse(ret, -EINVAL);
    if (hdr.records_count == 0) return refuse(ret, -EINVAL);
    if (hdr.record_stride != TENSION_2D_RECORD_SIZE) return refuse(ret, -EINVAL);
    if (bucket < 0) return refuse(ret, -EINVAL);

    const uint64_t bytes = static_cast<uint64_t>(hdr.records_count) * hdr.record_stride;
    if (bytes > 0xFFFFFFFFull) return refuse(ret, -EINVAL);

    std::vector<uint8_t> records;
    if (const int32_t rc = read_guest({hdr.records_ptr, static_cast<uint32_t>(bytes)}, records);
        rc != 0) {
        return refuse(ret, rc == -ENOSPC ? -EINVAL : rc);
    }

    uint32_t accepted = 0;
    std::string err;
    const int32_t rc = state.renderer.submit(static_cast<uint32_t>(pipe_id), records.data(),
                                             hdr.records_count, hdr.record_stride,
                                             static_cast<uint32_t>(bucket), accepted, err);
    if (rc != 0) {
        const std::string line = "2d: submit refused (" + err + ")";
        log_line(3, line.c_str());
        return refuse(ret, rc);
    }
    return answer(ret, static_cast<int32_t>(accepted));
}

int32_t shim_present(void *, const tension_value *args, uint32_t nargs, tension_value *ret) {
    if (nargs != 1) return refuse(ret, -EINVAL);
    AdapterState &state = adapter_state();
    if (args[0].i32 != state.handle || state.handle == 0) return refuse(ret, -EINVAL);

    std::string err;
    if (const int32_t rc = state.renderer.present(err); rc != 0) {
        const std::string line = "2d: present refused (" + err + ")";
        log_line(3, line.c_str());
        return refuse(ret, rc);
    }
    return answer(ret, 0);
}

int32_t shim_texture_load(void *, const tension_value *args, uint32_t nargs, tension_value *ret) {
    if (nargs != 4) return refuse(ret, -EINVAL);
    AdapterState &state = adapter_state();
    if (args[0].i32 != state.handle || state.handle == 0) return refuse(ret, -EINVAL);

    std::vector<uint8_t> source;
    if (const int32_t rc = read_guest({static_cast<uint32_t>(args[1].i32),
                                       static_cast<uint32_t>(args[2].i32)},
                                      source);
        rc != 0) {
        return refuse(ret, rc == -ENOSPC ? -EINVAL : rc);
    }

    uint32_t texture_id = 0;
    std::string err;
    const int32_t rc = state.renderer.texture_load(source.data(), source.size(), args[3].i32,
                                                   texture_id, err);
    if (rc != 0) {
        const std::string line = "2d: texture_load refused (" + err + ")";
        log_line(3, line.c_str());
        return refuse(ret, rc);
    }
    return answer(ret, static_cast<int32_t>(texture_id));
}

int32_t shim_set_texture(void *, const tension_value *args, uint32_t nargs, tension_value *ret) {
    if (nargs != 4) return refuse(ret, -EINVAL);
    AdapterState &state = adapter_state();
    if (args[0].i32 != state.handle || state.handle == 0) return refuse(ret, -EINVAL);
    if (args[1].i32 <= 0 || args[2].i32 < 0 || args[3].i32 <= 0) return refuse(ret, -EINVAL);

    std::string err;
    const int32_t rc = state.renderer.set_texture(static_cast<uint32_t>(args[1].i32),
                                                  static_cast<uint32_t>(args[2].i32),
                                                  static_cast<uint32_t>(args[3].i32), err);
    if (rc != 0) {
        const std::string line = "2d: set_texture refused (" + err + ")";
        log_line(3, line.c_str());
        return refuse(ret, rc);
    }
    return answer(ret, 0);
}

int32_t shim_info(void *, const tension_value *args, uint32_t nargs, tension_value *ret) {
    if (nargs != 3) return refuse(ret, -EINVAL);
    AdapterState &state = adapter_state();
    if (args[0].i32 != state.handle || state.handle == 0) return refuse(ret, -ENODEV);

    tension_2d_info_record info = {};
    info.version = 2;
    info.max_records = static_cast<uint16_t>(Renderer::max_records());
    info.max_textures = 64;
    info.max_pipelines = 16;
    info.max_buckets = static_cast<uint16_t>(Renderer::max_buckets());
    info.flags = 0;
    info.canvas_width = state.renderer.width();
    info.canvas_height = state.renderer.height();

    const uint32_t cap = static_cast<uint32_t>(args[2].i32);
    if (cap < sizeof info) return refuse(ret, -ENOSPC);
    if (const int32_t rc = write_guest(static_cast<uint32_t>(args[1].i32), cap, &info,
                                       sizeof info);
        rc != 0) {
        return refuse(ret, rc);
    }
    return answer(ret, static_cast<int32_t>(sizeof info));
}

int32_t shim_screenshot(void *, const tension_value *args, uint32_t nargs, tension_value *ret) {
    if (nargs != 3) return refuse(ret, -EINVAL);
    AdapterState &state = adapter_state();
    if (args[0].i32 != state.handle || state.handle == 0) return refuse(ret, -EINVAL);

    const uint32_t ptr = static_cast<uint32_t>(args[1].i32);
    const uint32_t cap = static_cast<uint32_t>(args[2].i32);
    const size_t needed = static_cast<size_t>(state.renderer.width()) * state.renderer.height() * 4u;
    if (cap < needed) return refuse(ret, -ENOSPC);

    std::vector<uint8_t> frame(needed);
    size_t written = 0;
    std::string err;
    const int32_t rc = state.renderer.screenshot(frame.data(), frame.size(), written, err);
    if (rc != 0) {
        const std::string line = "2d: screenshot refused (" + err + ")";
        log_line(3, line.c_str());
        return refuse(ret, rc);
    }
    if (const int32_t wr = write_guest(ptr, cap, frame.data(), static_cast<uint32_t>(written));
        wr != 0) {
        return refuse(ret, wr);
    }
    return answer(ret, static_cast<int32_t>(written));
}

// ── vtable ───────────────────────────────────────────────────────────────

int32_t adapter_init(void *ctx, const tension_core_api *core) {
    // The ABI version is checked here, as in tension-ogre and tension-input.
    //
    // This adapter did not check it until ABI v6. Nothing noticed, because the
    // three adapters are always rebuilt together in this repository — but the
    // check is the only thing that stops a stale DSO being loaded against a
    // newer host, and the `tension_core_api` grows by appending: a v5 adapter on
    // a v6 host reads every slot it knows about correctly and simply never sees
    // the new ones. That is exactly the case where silence is wrong, because the
    // missing slots are features it would silently not have.
    (void)ctx;
    if (core == nullptr || core->abi_version != TENSION_ADAPTER_ABI_VERSION) return -EINVAL;
    // The device is created in `open`, not here: "no GPU on this machine" is a
    // recoverable refusal at the verb, and a load failure is not, which is
    // tension-input's split exactly.
    adapter_state().api = nullptr;
    adapter_state().handle = 0;
    return 0;
}

int32_t adapter_link(void *, const tension_core_api *core) {
    AdapterState &state = adapter_state();
    if (core == nullptr) return -EINVAL;
    state.api = core;

    const uint32_t i32 = TENSION_VT_I32;
    const uint32_t one[1] = {i32};
    const uint32_t three[3] = {i32, i32, i32};
    const uint32_t four[4] = {i32, i32, i32, i32};
    const uint32_t five[5] = {i32, i32, i32, i32, i32};

    struct Registration {
        const char *name;
        const uint32_t *params;
        uint32_t nparams;
        tension_import_fn fn;
        uint32_t verb_id;
        uint32_t flags;
    };
    const Registration registrations[] = {
        // Three params: `open(width, height, flags)`. The signature the guest
        // sees is this table, not the shim's own reading of `nargs` — a shim
        // that accepts three from a one-param registration is a shim the real
        // session never calls (the C++ stub harness does not type-check the
        // registration, which is how the mismatch survived until the guest ran).
        {"open", three, 3, shim_open, kVerbOpen, 0},
        {"close", one, 1, shim_close, kVerbClose, 0},
        {"set_pipeline", three, 3, shim_set_pipeline, kVerbSetPipeline, 0},
        {"shader_compile_raw", five, 5, shim_shader_compile_raw, kVerbShaderCompileRaw, 0},
        {"submit", four, 4, shim_submit, kVerbSubmit, 0},
        {"present", one, 1, shim_present, kVerbPresent, 0},
        {"texture_load", four, 4, shim_texture_load, kVerbTextureLoad, 0},
        // Read-only snapshot: safe inside a callback, never pumps, never blocks.
        {"info", three, 3, shim_info, kVerbInfo, TENSION_IMPORT_REENTRANT_READONLY},
        {"screenshot", three, 3, shim_screenshot, kVerbScreenshot, 0},
        // Declared last so no existing verb id moves: ids are stable, and a
        // reused id is a silent misroute.
        {"set_texture", four, 4, shim_set_texture, kVerbSetTexture, 0},
    };

    for (const Registration &registration : registrations) {
        const int32_t rc = core->register_import(core->user, "tension::2d", registration.name,
                                                 TENSION_VT_I32, registration.params,
                                                 registration.nparams, registration.fn, nullptr,
                                                 registration.verb_id, registration.flags);
        if (rc != 0) {
            const std::string line = std::string("2d: link: registering `") + registration.name +
                                     "` refused (" + std::to_string(rc) + ")";
            log_line(3, line.c_str());
            return rc;
        }
    }
    log_line(1, "2d: link: ten verbs registered");
    return 0;
}

int32_t adapter_shutdown(void *) {
    adapter_state().renderer.close();
    adapter_state().handle = 0;
    return 0;
}

void adapter_destroy(void *) {
    adapter_state().renderer.close();
    adapter_state().handle = 0;
    adapter_state().api = nullptr;
}

} // namespace
} // namespace tension_2d

extern "C" const tension_adapter *tension_adapter_v1(void) {
    using namespace tension_2d;
    static const tension_adapter adapter = {
        TENSION_ADAPTER_ABI_VERSION, /* abi_version */
        "tension::2d",               /* name: the wasm module this implements */
        0,                           /* flags: reserved */
        adapter_init,                /* init */
        adapter_link,                /* link */
        nullptr,                     /* publish: v1 owns no regions */
        nullptr,                     /* apply: no deferrable verb */
        adapter_shutdown,            /* shutdown */
        adapter_destroy,             /* destroy */
        TENSION_ADAPTER_LAYOUT_HASH, /* layout_hash: the arena layout this was built against */
    };
    return &adapter;
}
