// The input capability's internal types: the two wire records as C++ sees
// them, and the thread that owns SDL.
//
// Nothing here includes an SDL header. The thread's SDL objects are `void *`
// at this boundary; src/input.cpp is the only file that knows what they are.
// That keeps the capability's SDL coupling in one translation unit, and it is
// what lets the adapter (src/adapter.cpp) stay a pure ABI file.

#ifndef TENSION_INPUT_INTERNAL_H
#define TENSION_INPUT_INTERNAL_H

#include <atomic>
#include <condition_variable>
#include <cstddef>
#include <cstdint>
#include <mutex>
#include <string>
#include <thread>

#include "tension_adapter.h" /* the core API type the thread posts through */
#include "tension_input.h"

namespace tension_input {

/// One `[tension:input]` line, implemented by the adapter, which owns the API
/// table. The thread formats diagnostics; it does not own the log.
void input_log(const std::string &message);

/// `class_info`'s flags word, bit 0: the class has a subscriber, so a producer
/// that can skip work nobody asked for should keep producing
/// (tension-core/src/session/arena.rs, `CLASS_FLAG_SUBSCRIBED`).
constexpr uint32_t kClassFlagSubscribed = 1u << 0;

/// How long after a successful attach motion events are discarded: they are the
/// window settling under the pointer and the confinement warp, not input.
/// Measured at 137 ms and 343 ms, so half a second covers both (INPUT.md §3 Q5).
constexpr uint32_t kAttachSettleMs = 500;

/// The state record, INPUT.md §3 Q5. Offsets are the wire; the static_assert
/// below is what keeps this struct and the header's table from drifting apart.
struct StateRecord {
    uint32_t version;
    uint32_t flags;
    uint32_t pads_present;
    uint32_t mouse_buttons;
    uint32_t keys_held[8]; /* 256 scancodes */
    int32_t mouse_dx;
    int32_t mouse_dy;
    float mouse_dxf;
    float mouse_dyf;
    int32_t mouse_x;
    int32_t mouse_y;
    float wheel_x;
    float wheel_y;
    uint64_t seq;
    uint64_t reserved;
};
static_assert(sizeof(StateRecord) == TENSION_INPUT_STATE_SIZE,
              "the state record is the size the wire declares");
static_assert(offsetof(StateRecord, mouse_dxf) == 56,
              "the float delta is where the guest reads it");

/// The gamepad slot record, INPUT.md §3 Q5 (v1's state half).
struct PadRecord {
    uint32_t version;
    uint32_t flags;
    uint32_t buttons;
    uint32_t reserved0;
    float axes[6];
    uint64_t reserved1;
};
static_assert(sizeof(PadRecord) == TENSION_INPUT_PAD_SIZE,
              "the pad record is the size the wire declares");

/// The SDL-owning thread. One per process — SDL's subsystem state is, and the
/// aspect table says so (INPUT.md §3 Q2).
///
/// The contract, from INPUT.md §3 Q4: the thread is created in `init` and its
/// first act is `SDL_Init`; every other call here is a *request* to that thread
/// that waits, bounded, for its answer, because SDL's window functions must run
/// on the thread that initialised SDL.
class InputThread {
  public:
    InputThread() = default;
    ~InputThread();
    InputThread(const InputThread &) = delete;
    InputThread &operator=(const InputThread &) = delete;

    /// Spawn the thread and wait for its `SDL_Init` result. Returns 0 when the
    /// thread is running — `sdl_up()` says whether SDL came up — and -EIO when
    /// the thread itself could not be created.
    int32_t start();

    /// Ask the thread to stop and join. Idempotent.
    ///
    /// `quit_sdl` says whether the thread tears SDL down on its way out. It is
    /// true for `input_close` and the vtable's `shutdown` — a host that unloads
    /// the DSO later must not find threads in it — and false from the
    /// destructor, where the process is already ending and asking SDL to quit
    /// from inside the loader's unload callback is the deadlock that was
    /// measured (`SDL_Quit` never returned; see DESIGN.md §7).
    void stop(bool quit_sdl = true);

    /// Whether the thread is running (it stops on `input_close`).
    bool running() const;

    bool sdl_up() const { return sdl_up_.load(std::memory_order_acquire); }

    /// The video driver the subsystem came up with, or "(none)".
    std::string driver() const;

    /// Attach to a surface (inputs: the token kind and its two halves). Runs on
    /// the SDL thread. Also arms the attach-settle discard window.
    int32_t attach(uint32_t kind, uint64_t token);

    /// Destroy the window (input's own, or the attachment to someone else's).
    int32_t detach();

    /// SDL relative mouse mode on/off.
    int32_t set_relative(bool on);

    /// Re-attempt `SDL_Init` on the SDL thread. `input_open` is where the
    /// subsystem is retried, so a machine whose display appeared late is not
    /// refused forever (INPUT.md §4's failure contract).
    int32_t retry_sdl();

    /// Compose one state record and consume the motion it carries.
    void snapshot(StateRecord *out);

    /// One gamepad slot's record; false when the slot has no pad.
    bool pad(uint32_t slot, PadRecord *out);

    /// The subsystem's gamepad slots, refreshed on a timer and on hotplug.
    void note_pad_change() { refresh_pads(); }

    /// Where events are posted from; set once at `link`.
    void set_poster(const tension_core_api *api, uint32_t source_id);

  private:
    enum class Request { None, Attach, Detach, SetRelative, RetrySdl };

    void thread_main();
    int32_t sdl_start();     // on the SDL thread: SDL_Init(VIDEO|GAMEPAD)
    void sdl_stop(bool quit_sdl);  // on the SDL thread: window, SDL_Quit
    int32_t sdl_attach(uint32_t kind, uint64_t token);
    void sdl_detach();
    void pump_events();
    void refresh_pads();
    int32_t sdl_set_relative(bool on);

    /// Queue a request and wait, bounded, for its answer. -EIO on timeout.
    int32_t request_attach(uint32_t kind, uint64_t token);
    int32_t request_detach();
    int32_t request_set_relative(bool on);
    int32_t request_retry_sdl();

    void post(uint32_t class_id, uint32_t flags, uint32_t a, uint32_t b, float f0, float f1);
    bool subscribed(uint32_t class_id) const;

    void push_motion(float dx, float dy, float x, float y);

    std::thread thread_;
    mutable std::mutex mu_;
    std::condition_variable work_cv_;     // thread <- request
    std::condition_variable done_cv_;     // requester <- answer
    std::condition_variable startup_cv_;  // start() <- the SDL_Init result
    bool started_ = false;
    bool stop_requested_ = false;
    bool startup_done_ = false;

    // ── set by the SDL thread, read anywhere ─────────────────────────────
    std::atomic<bool> sdl_up_{false};
    std::atomic<bool> attached_{false};
    std::atomic<bool> relative_{false};
    std::atomic<bool> focused_{false};
    std::atomic<bool> pointer_over_{false};
    char driver_[32] = {0};

    // ── the request slot, guarded by mu_ ────────────────────────────────
    Request request_ = Request::None;
    uint32_t req_kind_ = 0;
    uint64_t req_token_ = 0;
    bool req_relative_ = false;
    bool req_done_ = false;
    int32_t req_result_ = 0;

    // ── the mirror, guarded by mu_ (the thread writes, snapshot reads) ──
    uint32_t keys_held_[8] = {0};
    uint32_t mouse_buttons_ = 0;
    uint32_t pads_present_ = 0;
    int32_t mouse_x_ = 0;
    int32_t mouse_y_ = 0;
    float accum_dx_ = 0.0f;
    float accum_dy_ = 0.0f;
    float accum_wheel_x_ = 0.0f;
    float accum_wheel_y_ = 0.0f;
    uint64_t last_seq_ = 0;
    PadRecord pad_records_[TENSION_INPUT_PAD_SLOTS] = {};
    bool pad_live_[TENSION_INPUT_PAD_SLOTS] = {false};

    // ── owned by the SDL thread, read there only ────────────────────────
    void *window_ = nullptr; /* SDL_Window * */
    void *pads_[TENSION_INPUT_PAD_SLOTS] = {nullptr};  /* SDL_Gamepad * */
    uint32_t pad_ids_[TENSION_INPUT_PAD_SLOTS] = {0};  /* SDL_JoystickID */
    uint64_t discard_motion_until_ms_ = 0;             /* the attach-settle rule */

    // ── posting; `link` fills these after `init` started the thread ─────
    /// Whether the thread tears SDL down on its way out; set by `stop`.
    bool quitting_sdl_ = true;
    std::atomic<const tension_core_api *> api_{nullptr};
    std::atomic<uint32_t> source_id_{0};
};

/// Monotonic milliseconds, the clock every timeout here uses.
uint64_t now_ms();

} // namespace tension_input

#endif // TENSION_INPUT_INTERNAL_H
