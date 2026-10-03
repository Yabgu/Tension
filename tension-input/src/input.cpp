// The input capability's thread: the one place that knows what SDL is.
//
// The shape INPUT.md §3 Q4 recommends, and the round-21 probe measured as
// viable: one thread owns SDL from `SDL_Init` onward — attach, pump, gamepad
// state — while the renderer pumps its own X connection on another thread and
// nothing is serialised between them. Every call the adapter makes into here
// other than `start`/`stop`/`snapshot`/`pad` is a request to that thread, and
// each of those waits bounded for its answer, because SDL's window functions
// must run on the thread that initialised SDL.
//
// Three measured rules live here (round 20's corrections to INPUT.md, from
// round 21's probe):
//   * motion with `which == 0` is position-derived, not device motion, and is
//     dropped before the accumulator;
//   * the first `kAttachSettleMs` of motion after an attach is the window and
//     the pointer-confinement settling, and is dropped too;
//   * motion is accumulated, never posted — one delta per snapshot, because a
//     1 kHz device against a 64-slot ring is a statistic, not a stream.

#include "input.h"

#include <SDL3/SDL.h>

#include <dlfcn.h>
#include <pthread.h>

#include <cerrno>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <string>

namespace tension_input {

uint64_t now_ms() {
    using namespace std::chrono;
    return static_cast<uint64_t>(
        duration_cast<milliseconds>(steady_clock::now().time_since_epoch()).count());
}

namespace {

/// The driver a token kind needs, or nullptr when the kind does not care.
const char *driver_for_kind(uint32_t kind) {
    return kind == 1 ? "x11" : nullptr; /* kind 1 is an X11 window id */
}

// ── resolving an X11 token before SDL does ──────────────────────────────
//
// Measured twice, with libtension_input's own isolation test and a bogus
// token: Xlib's *default* error handler prints BadWindow and exits the process
// from SDL's thread, so the verb never answers; and with a quiet handler
// installed, SDL returns a window built from an uninitialized
// `XWindowAttributes` — the attach's size check refused it once (a negative
// garbage size) and accepted it once (a positive one). Either way the design's
// `-ENOENT` ("no such window") never happened.
//
// So the token is resolved here first, on the capability's own X connection,
// with a quiet handler for the probe and the previous handler restored after
// it. `libX11` is `dlopen`ed, not linked: SDL already has it in the process on
// this platform, and a build for one that does not must still load.
#if defined(__linux__)
bool g_x11_probe_saw_error = false;

int x11_probe_error_handler(void *, void *) {
    g_x11_probe_saw_error = true;
    return 0;
}

/// 0 = the token names a window; -ENOENT = it does not; -ENOSYS = no way to
/// ask (no libX11, or no X display), in which case SDL's own answer stands.
int32_t x11_probe_window(uint64_t token) {
    void *lib = dlopen("libX11.so.6", RTLD_NOW | RTLD_LOCAL);
    if (lib == nullptr) return -ENOSYS;
    using OpenDisplayFn = void *(*)(const char *);
    using GetGeometryFn = int (*)(void *, unsigned long, unsigned long *, int *, int *, unsigned int *,
                                  unsigned int *, unsigned int *, unsigned int *);
    using SyncFn = int (*)(void *, int);
    using ErrorHandlerFn = int (*)(void *, void *);
    using SetHandlerFn = ErrorHandlerFn (*)(ErrorHandlerFn);
    auto open_display = reinterpret_cast<OpenDisplayFn>(dlsym(lib, "XOpenDisplay"));
    auto get_geometry = reinterpret_cast<GetGeometryFn>(dlsym(lib, "XGetGeometry"));
    auto sync = reinterpret_cast<SyncFn>(dlsym(lib, "XSync"));
    auto set_handler = reinterpret_cast<SetHandlerFn>(dlsym(lib, "XSetErrorHandler"));
    auto close_display = reinterpret_cast<int (*)(void *)>(dlsym(lib, "XCloseDisplay"));
    if (open_display == nullptr || get_geometry == nullptr || sync == nullptr ||
        set_handler == nullptr || close_display == nullptr) {
        dlclose(lib);
        return -ENOSYS;
    }
    void *display = open_display(nullptr);
    if (display == nullptr) {
        dlclose(lib);
        return -ENOSYS;
    }
    g_x11_probe_saw_error = false;
    // Save what was there — SDL installs its own handler at SDL_Init, and
    // installing the default back (`nullptr`) would take SDL's place and make
    // the next asynchronous X error exit the process.
    ErrorHandlerFn previous = set_handler(x11_probe_error_handler);
    unsigned long root = 0;
    int x = 0, y = 0;
    unsigned int width = 0, height = 0, border = 0, depth = 0;
    (void)get_geometry(display, static_cast<unsigned long>(token), &root, &x, &y, &width, &height,
                       &border, &depth);
    sync(display, 0); /* errors are asynchronous: the round-trip is the answer */
    set_handler(previous);
    const bool saw_error = g_x11_probe_saw_error;
    close_display(display);
    dlclose(lib);
    if (saw_error || width < 1 || height < 1) return -ENOENT;
    return 0;
}
#else
int32_t x11_probe_window(uint64_t) { return -ENOSYS; }
#endif

} // namespace

InputThread::~InputThread() {
    // No SDL_Quit here: see the header. The process is ending, and the teardown
    // that matters ran in `input_close`.
    stop(/*quit_sdl=*/false);
}

// ── the thread's life ───────────────────────────────────────────────────

int32_t InputThread::start() {
    {
        std::lock_guard<std::mutex> lock(mu_);
        if (started_) return 0;
        started_ = true;
        stop_requested_ = false;
        startup_done_ = false;
    }
    try {
        thread_ = std::thread(&InputThread::thread_main, this);
    } catch (...) {
        std::lock_guard<std::mutex> lock(mu_);
        started_ = false;
        return -EIO;
    }
    std::unique_lock<std::mutex> lock(mu_);
    if (!startup_cv_.wait_for(lock, std::chrono::seconds(5), [this] { return startup_done_; })) {
        input_log("input: the SDL thread did not report startup within 5 s");
        return -EIO;
    }
    return 0;
}

bool InputThread::running() const {
    std::lock_guard<std::mutex> lock(mu_);
    return started_;
}

void InputThread::stop(bool quit_sdl) {
    if (thread_.joinable() && thread_.get_id() == std::this_thread::get_id()) {
        // Called from the SDL thread itself (a teardown running on it, or a
        // platform error handler that exits from it): joining would be EDEADLK
        // and the throw would terminate the process. Leave the thread to the
        // process; `started_` stays true, which is the truth.
        input_log("input: stop() called on the SDL thread; detaching instead of joining self");
        // Detach, not just return: the member `thread_` is destroyed with this
        // object, and a joinable std::thread's destructor terminates the
        // process. Detaching hands the thread to the runtime, which is the only
        // safe thing left when the teardown is running on it.
        thread_.detach();
        return;
    }
    {
        std::lock_guard<std::mutex> lock(mu_);
        if (!started_) return;
        stop_requested_ = true;
        if (request_ != Request::None) {
            // A request in flight when the stop lands gets an answer, so its
            // requester is never left waiting on a thread that is leaving.
            req_result_ = -EIO;
            req_done_ = true;
        }
    }
    quitting_sdl_ = quit_sdl; /* the thread reads it in sdl_stop */
    work_cv_.notify_all();
    done_cv_.notify_all();
    if (thread_.joinable()) thread_.join();
    {
        std::lock_guard<std::mutex> lock(mu_);
        started_ = false;
    }
}

std::string InputThread::driver() const {
    std::lock_guard<std::mutex> lock(mu_);
    return driver_[0] != 0 ? std::string(driver_) : std::string("(none)");
}

void InputThread::thread_main() {
    pthread_setname_np(pthread_self(), "tension-input");
    const int32_t rc = sdl_start();
    {
        std::lock_guard<std::mutex> lock(mu_);
        startup_done_ = true;
    }
    startup_cv_.notify_all();
    if (rc != 0) {
        input_log("input: SDL is not up; verbs refuse with -ENODEV until it is");
    }
    refresh_pads();

    uint32_t since_pad_poll = 0;
    for (;;) {
        Request req = Request::None;
        uint32_t kind = 0;
        uint64_t token = 0;
        bool relative = false;
        {
            std::unique_lock<std::mutex> lock(mu_);
            work_cv_.wait_for(lock, std::chrono::milliseconds(2),
                              [this] { return stop_requested_ || request_ != Request::None; });
            if (stop_requested_) break;
            req = request_;
            kind = req_kind_;
            token = req_token_;
            relative = req_relative_;
            request_ = Request::None;
        }
        if (req != Request::None) {
            int32_t result = -EIO;
            switch (req) {
                case Request::Attach:
                    result = sdl_attach(kind, token);
                    break;
                case Request::Detach:
                    sdl_detach();
                    result = 0;
                    break;
                case Request::SetRelative:
                    result = sdl_set_relative(relative);
                    break;
                case Request::RetrySdl:
                    result = sdl_up() ? 0 : sdl_start();
                    if (result == 0) refresh_pads();
                    break;
                case Request::None:
                    break;
            }
            {
                std::lock_guard<std::mutex> lock(mu_);
                req_result_ = result;
                req_done_ = true;
            }
            done_cv_.notify_all();
        }
        pump_events();
        if (++since_pad_poll >= 25) { /* ~50 ms at the 2 ms tick */
            since_pad_poll = 0;
            refresh_pads();
        }
    }
    sdl_stop(quitting_sdl_);
}

// ── SDL, on the SDL thread ──────────────────────────────────────────────

int32_t InputThread::sdl_start() {
    if (!SDL_Init(SDL_INIT_VIDEO | SDL_INIT_GAMEPAD)) {
        input_log(std::string("input: SDL_Init(VIDEO|GAMEPAD) failed: ") + SDL_GetError());
        sdl_up_.store(false, std::memory_order_release);
        return -ENODEV;
    }
    const char *drv = SDL_GetCurrentVideoDriver();
    {
        std::lock_guard<std::mutex> lock(mu_);
        std::snprintf(driver_, sizeof(driver_), "%s", drv != nullptr ? drv : "(none)");
    }
    sdl_up_.store(true, std::memory_order_release);
    input_log(std::string("input: SDL up, video driver '") + (drv != nullptr ? drv : "(none)") + "'");
    return 0;
}

void InputThread::sdl_stop(bool quit_sdl) {
    sdl_detach();
    if (quit_sdl && sdl_up()) {
        SDL_Quit();
        sdl_up_.store(false, std::memory_order_release);
    }
    input_log("input: SDL thread exiting");
}

int32_t InputThread::sdl_attach(uint32_t kind, uint64_t token) {
    if (!sdl_up()) {
        // The device precedent (SESSION.md §8): the subsystem is re-acquirable,
        // so a later attach may succeed where an earlier one was refused.
        if (sdl_start() != 0) return -ENODEV;
    }
    if (kind > 4) return -EINVAL;
    if (kind >= 2) {
        input_log("input: attach: token kind " + std::to_string(kind) +
                  " is not served by this build");
        return -ENOSYS;
    }

    // Force the driver the kind needs. Round 20 measured the failure this
    // prevents: with the wrong driver, SDL_CreateWindowWithProperties returns a
    // live window that is not the target, with no error at all.
    if (const char *want = driver_for_kind(kind)) {
        const char *have = SDL_GetCurrentVideoDriver();
        if (have == nullptr || std::strcmp(have, want) != 0) {
            input_log(std::string("input: attach: kind ") + std::to_string(kind) + " needs '" + want +
                      "', forcing it (was '" + (have != nullptr ? have : "(none)") + "')");
            SDL_Quit();
            sdl_up_.store(false, std::memory_order_release);
            SDL_SetHint(SDL_HINT_VIDEO_DRIVER, want);
            if (sdl_start() != 0) return -ENODEV;
            refresh_pads();
        }
    }

    if (kind == 1) {
        const int32_t probed = x11_probe_window(token);
        if (probed == -ENOENT) {
            input_log("input: attach: the token names no window (X11 probe)");
            return -ENOENT;
        }
        /* -ENOSYS: no libX11 or no X display here; SDL's own answer stands. */
    }

    SDL_Window *window = nullptr;
    if (kind == 0) {
        // input's own surface: a text game's window, no renderer involved.
        window = SDL_CreateWindow("tension-input", 320, 200, 0);
        if (window == nullptr) {
            input_log(std::string("input: attach: SDL could not make a window: ") + SDL_GetError());
            return -ENODEV;
        }
        // Ask for the keyboard. Measured before this: the window never held
        // focus on Wayland, so the keyboard half of the edge test produced
        // nothing (150 s of runs, `epochs focused = 0`). A client cannot force
        // focus here — the compositor decides — so the ask is best-effort and
        // the log line below is the honest answer, not an assumption.
        if (!SDL_SetWindowFocusable(window, true)) {
            input_log(std::string("input: attach: SDL_SetWindowFocusable refused: ") + SDL_GetError());
        }
        SDL_ShowWindow(window);
        SDL_RaiseWindow(window);
        {
            const SDL_WindowFlags flags = SDL_GetWindowFlags(window);
            char line[192];
            std::snprintf(line, sizeof(line),
                          "input: attach: window %u '%s' shown+raised; input-focus=%d (Wayland: "
                          "the compositor decides, and this is the ask's first answer)",
                          (unsigned)SDL_GetWindowID(window), SDL_GetWindowTitle(window),
                          (flags & SDL_WINDOW_INPUT_FOCUS) != 0 ? 1 : 0);
            input_log(line);
        }
    } else {
        SDL_PropertiesID props = SDL_CreateProperties();
        SDL_SetNumberProperty(props, SDL_PROP_WINDOW_CREATE_X11_WINDOW_NUMBER, (Sint64)token);
        window = SDL_CreateWindowWithProperties(props);
        SDL_DestroyProperties(props);
        if (window == nullptr) {
            const std::string error = SDL_GetError();
            input_log("input: attach: SDL refused the token: " + error);
            // SDL refuses a token that names nothing with a window-shaped
            // error; anything else is the platform saying no.
            return error.find("window") != std::string::npos ? -ENOENT : -EIO;
        }
    }

    // Verify the attach: a token attach that silently missed is the round-20
    // failure mode, and the cheapest honest check is that the window has a
    // real size (the measured miss was 1x1 with no title).
    int width = 0, height = 0;
    SDL_GetWindowSize(window, &width, &height);
    if (width <= 1 || height <= 1) {
        input_log("input: attach did not verify: size " + std::to_string(width) + "x" +
                  std::to_string(height));
        SDL_DestroyWindow(window);
        return -EIO;
    }

    window_ = window;
    discard_motion_until_ms_ = now_ms() + kAttachSettleMs;
    {
        std::lock_guard<std::mutex> lock(mu_);
        std::memset(keys_held_, 0, sizeof(keys_held_));
        mouse_buttons_ = 0;
        accum_dx_ = accum_dy_ = accum_wheel_x_ = accum_wheel_y_ = 0.0f;
    }
    attached_.store(true, std::memory_order_release);
    input_log("input: attached kind " + std::to_string(kind) + " as " + std::to_string(width) + "x" +
              std::to_string(height) + "; discarding " + std::to_string(kAttachSettleMs) +
              " ms of settling motion");
    return 0;
}

void InputThread::sdl_detach() {
    if (window_ != nullptr) {
        SDL_DestroyWindow(static_cast<SDL_Window *>(window_));
        window_ = nullptr;
    }
    attached_.store(false, std::memory_order_release);
    relative_.store(false, std::memory_order_release);
    focused_.store(false, std::memory_order_release);
    pointer_over_.store(false, std::memory_order_release);
    {
        std::lock_guard<std::mutex> lock(mu_);
        mouse_buttons_ = 0;
        std::memset(keys_held_, 0, sizeof(keys_held_));
        accum_dx_ = accum_dy_ = accum_wheel_x_ = accum_wheel_y_ = 0.0f;
    }
}

int32_t InputThread::sdl_set_relative(bool on) {
    if (!attached_.load(std::memory_order_acquire) || window_ == nullptr) return -ENODEV;
    if (!SDL_SetWindowRelativeMouseMode(static_cast<SDL_Window *>(window_), on)) {
        input_log(std::string("input: SDL_SetWindowRelativeMouseMode refused: ") + SDL_GetError());
        return -EIO;
    }
    relative_.store(on, std::memory_order_release);
    input_log(std::string("input: relative mouse mode ") + (on ? "on" : "off"));
    return 0;
}

// ── the pump ────────────────────────────────────────────────────────────

void InputThread::push_motion(float dx, float dy, float x, float y) {
    std::lock_guard<std::mutex> lock(mu_);
    accum_dx_ += dx;
    accum_dy_ += dy;
    mouse_x_ = static_cast<int32_t>(x);
    mouse_y_ = static_cast<int32_t>(y);
}

void InputThread::pump_events() {
    if (!sdl_up()) return;
    const uint64_t now = now_ms();
    SDL_Event e;
    while (SDL_PollEvent(&e)) {
        switch (e.type) {
            case SDL_EVENT_MOUSE_MOTION:
                // `which == 0` is position-derived (a window moved under the
                // pointer), not device motion — never the accumulator's.
                if (e.motion.which == 0) break;
                if (now < discard_motion_until_ms_) break;
                push_motion(e.motion.xrel, e.motion.yrel, e.motion.x, e.motion.y);
                break;
            case SDL_EVENT_KEY_DOWN:
            case SDL_EVENT_KEY_UP: {
                const bool down = e.type == SDL_EVENT_KEY_DOWN;
                uint32_t flags = down ? TENSION_INPUT_KEY_DOWN : 0u;
                if (e.key.repeat) flags |= TENSION_INPUT_KEY_REPEAT;
                if (e.key.key == SDLK_UNKNOWN && e.key.scancode == SDL_SCANCODE_UNKNOWN)
                    flags |= TENSION_INPUT_KEY_SYNTHETIC;
                if (down || !down) {
                    std::lock_guard<std::mutex> lock(mu_);
                    const uint32_t bit = static_cast<uint32_t>(e.key.scancode);
                    if (bit < 256) {
                        if (down) keys_held_[bit >> 5] |= (1u << (bit & 31));
                        else keys_held_[bit >> 5] &= ~(1u << (bit & 31));
                    }
                }
                post(TENSION_INPUT_CLASS_INPUT_KEY, flags, static_cast<uint32_t>(e.key.key),
                     static_cast<uint32_t>(e.key.scancode), 0.0f, 0.0f);
                break;
            }
            case SDL_EVENT_MOUSE_BUTTON_DOWN:
            case SDL_EVENT_MOUSE_BUTTON_UP: {
                const bool down = e.type == SDL_EVENT_MOUSE_BUTTON_DOWN;
                // SDL3's button event carries no mask; the live state is a call.
                const uint32_t mask =
                    static_cast<uint32_t>(SDL_GetMouseState(nullptr, nullptr));
                {
                    std::lock_guard<std::mutex> lock(mu_);
                    mouse_buttons_ = mask;
                }
                uint32_t flags = TENSION_INPUT_MOUSE_SHAPE_BUTTON;
                if (down) flags |= TENSION_INPUT_MOUSE_BUTTON_DOWN;
                post(TENSION_INPUT_CLASS_INPUT_MOUSE, flags, static_cast<uint32_t>(e.button.button),
                     mask, 0.0f, 0.0f);
                break;
            }
            case SDL_EVENT_MOUSE_WHEEL:
                post(TENSION_INPUT_CLASS_INPUT_MOUSE, TENSION_INPUT_MOUSE_SHAPE_WHEEL, 0, 0,
                     e.wheel.x, e.wheel.y);
                break;
            case SDL_EVENT_WINDOW_FOCUS_GAINED:
                focused_.store(true, std::memory_order_release);
                input_log("input: window " + std::to_string((unsigned)e.window.windowID) + " focused");
                break;
            case SDL_EVENT_WINDOW_FOCUS_LOST:
                focused_.store(false, std::memory_order_release);
                break;
            case SDL_EVENT_WINDOW_MOUSE_ENTER:
                pointer_over_.store(true, std::memory_order_release);
                break;
            case SDL_EVENT_WINDOW_MOUSE_LEAVE:
                pointer_over_.store(false, std::memory_order_release);
                break;
            case SDL_EVENT_GAMEPAD_ADDED:
            case SDL_EVENT_GAMEPAD_REMOVED:
            case SDL_EVENT_JOYSTICK_ADDED:
            case SDL_EVENT_JOYSTICK_REMOVED:
                refresh_pads();
                break;
            default:
                break;
        }
    }
}

void InputThread::refresh_pads() {
    if (!sdl_up()) return;
    int count = 0;
    SDL_JoystickID *ids = SDL_GetGamepads(&count);
    if (ids == nullptr) count = 0;

    // Slots whose pad is gone.
    for (uint32_t slot = 0; slot < TENSION_INPUT_PAD_SLOTS; ++slot) {
        if (pads_[slot] == nullptr) continue;
        bool present = false;
        for (int i = 0; i < count; ++i)
            if (static_cast<uint32_t>(ids[i]) == pad_ids_[slot]) present = true;
        if (!present) {
            SDL_CloseGamepad(static_cast<SDL_Gamepad *>(pads_[slot]));
            pads_[slot] = nullptr;
            pad_ids_[slot] = 0;
            std::lock_guard<std::mutex> lock(mu_);
            pad_live_[slot] = false;
            pads_present_ &= ~(1u << slot);
        }
    }
    // Pads that are new to us.
    for (int i = 0; i < count; ++i) {
        bool held = false;
        for (uint32_t slot = 0; slot < TENSION_INPUT_PAD_SLOTS; ++slot)
            if (pads_[slot] != nullptr && pad_ids_[slot] == static_cast<uint32_t>(ids[i]))
                held = true;
        if (held) continue;
        for (uint32_t slot = 0; slot < TENSION_INPUT_PAD_SLOTS; ++slot) {
            if (pads_[slot] != nullptr) continue;
            SDL_Gamepad *pad = SDL_OpenGamepad(ids[i]);
            if (pad == nullptr) {
                input_log(std::string("input: a gamepad could not be opened: ") + SDL_GetError());
                break;
            }
            pads_[slot] = pad;
            pad_ids_[slot] = static_cast<uint32_t>(ids[i]);
            const char *name = SDL_GetGamepadName(pad);
            input_log("input: gamepad slot " + std::to_string(slot) + " '" +
                      (name != nullptr ? name : "(unnamed)") + "'");
            break;
        }
    }
    if (ids != nullptr) SDL_free(ids);

    // The live slots' records: buttons and axes, normalised once, here, so the
    // guest never sees SDL's raw Sint16 range.
    for (uint32_t slot = 0; slot < TENSION_INPUT_PAD_SLOTS; ++slot) {
        SDL_Gamepad *pad = static_cast<SDL_Gamepad *>(pads_[slot]);
        if (pad == nullptr) continue;
        PadRecord record = {};
        record.version = TENSION_INPUT_PAD_VERSION;
        record.flags = TENSION_INPUT_PAD_ATTACHED;
        for (int b = 0; b < SDL_GAMEPAD_BUTTON_COUNT; ++b)
            if (SDL_GetGamepadButton(pad, static_cast<SDL_GamepadButton>(b)))
                record.buttons |= (1u << b);
        for (int a = 0; a < SDL_GAMEPAD_AXIS_COUNT; ++a) {
            const float raw = static_cast<float>(
                SDL_GetGamepadAxis(pad, static_cast<SDL_GamepadAxis>(a))) / 32767.0f;
            float value = raw;
            if (a == SDL_GAMEPAD_AXIS_LEFT_TRIGGER || a == SDL_GAMEPAD_AXIS_RIGHT_TRIGGER)
                value = value < 0.0f ? 0.0f : value;
            record.axes[a] = value > 1.0f ? 1.0f : (value < -1.0f ? -1.0f : value);
        }
        std::lock_guard<std::mutex> lock(mu_);
        pad_records_[slot] = record;
        pad_live_[slot] = true;
        pads_present_ |= (1u << slot);
    }
}

// ── posting, and the two readers ────────────────────────────────────────

bool InputThread::subscribed(uint32_t class_id) const {
    const tension_core_api *api = api_.load(std::memory_order_acquire);
    if (api == nullptr || api->class_info == nullptr) return true;
    uint32_t mode = 0, capacity = 0, flags = 0;
    if (api->class_info(api->user, class_id, &mode, &capacity, &flags) != 0) return true;
    return (flags & kClassFlagSubscribed) != 0;
}

void InputThread::post(uint32_t class_id, uint32_t flags, uint32_t a, uint32_t b, float f0,
                       float f1) {
    const tension_core_api *api = api_.load(std::memory_order_acquire);
    if (api == nullptr || api->post_event == nullptr) return;
    if (!subscribed(class_id)) return; /* a producer may skip work nobody asked for */
    uint64_t seq = 0;
    if (api->post_event(api->user, source_id_.load(std::memory_order_relaxed), class_id, flags, a, b,
                        f0, f1, &seq) == 0 &&
        seq != 0) {
        std::lock_guard<std::mutex> lock(mu_);
        if (seq > last_seq_) last_seq_ = seq;
    }
}

void InputThread::snapshot(StateRecord *out) {
    std::lock_guard<std::mutex> lock(mu_);
    std::memset(out, 0, sizeof(*out));
    out->version = TENSION_INPUT_STATE_VERSION;
    uint32_t flags = 0;
    if (attached_.load(std::memory_order_acquire)) flags |= TENSION_INPUT_STATE_ATTACHED;
    if (relative_.load(std::memory_order_acquire)) flags |= TENSION_INPUT_STATE_RELATIVE;
    if (focused_.load(std::memory_order_acquire)) flags |= TENSION_INPUT_STATE_FOCUSED;
    if (pointer_over_.load(std::memory_order_acquire)) flags |= TENSION_INPUT_STATE_POINTER_OVER;
    out->flags = flags;
    out->pads_present = pads_present_;
    out->mouse_buttons = mouse_buttons_;
    std::memcpy(out->keys_held, keys_held_, sizeof(keys_held_));

    // The delta: floats are authoritative, the integers are their truncation,
    // and the remainder stays in the accumulator for the next snapshot — so a
    // slow subpixel drag degrades in resolution but never disappears.
    const float dxf = accum_dx_;
    const float dyf = accum_dy_;
    out->mouse_dxf = dxf;
    out->mouse_dyf = dyf;
    out->mouse_dx = static_cast<int32_t>(std::trunc(dxf));
    out->mouse_dy = static_cast<int32_t>(std::trunc(dyf));
    accum_dx_ = dxf - static_cast<float>(out->mouse_dx);
    accum_dy_ = dyf - static_cast<float>(out->mouse_dy);

    out->mouse_x = mouse_x_;
    out->mouse_y = mouse_y_;
    out->wheel_x = accum_wheel_x_;
    out->wheel_y = accum_wheel_y_;
    accum_wheel_x_ = 0.0f;
    accum_wheel_y_ = 0.0f;
    out->seq = last_seq_;
}

bool InputThread::pad(uint32_t slot, PadRecord *out) {
    if (slot >= TENSION_INPUT_PAD_SLOTS) return false;
    std::lock_guard<std::mutex> lock(mu_);
    if (!pad_live_[slot]) return false;
    *out = pad_records_[slot];
    return true;
}

// ── requests: the adapter's face, answered by the SDL thread ────────────

int32_t InputThread::request_attach(uint32_t kind, uint64_t token) {
    std::unique_lock<std::mutex> lock(mu_);
    if (!started_) return -EIO;
    if (request_ != Request::None) return -EBUSY;
    req_kind_ = kind;
    req_token_ = token;
    req_relative_ = false;
    req_result_ = 0;
    req_done_ = false;
    request_ = Request::Attach;
    work_cv_.notify_all();
    if (!done_cv_.wait_for(lock, std::chrono::seconds(5), [this] { return req_done_; })) return -EIO;
    return req_result_;
}

int32_t InputThread::request_detach() {
    std::unique_lock<std::mutex> lock(mu_);
    if (!started_) return -EIO;
    if (request_ != Request::None) return -EBUSY;
    req_result_ = 0;
    req_done_ = false;
    request_ = Request::Detach;
    work_cv_.notify_all();
    if (!done_cv_.wait_for(lock, std::chrono::seconds(5), [this] { return req_done_; })) return -EIO;
    return req_result_;
}

int32_t InputThread::request_retry_sdl() {
    std::unique_lock<std::mutex> lock(mu_);
    if (!started_) return -EIO;
    if (request_ != Request::None) return -EBUSY;
    req_result_ = 0;
    req_done_ = false;
    request_ = Request::RetrySdl;
    work_cv_.notify_all();
    if (!done_cv_.wait_for(lock, std::chrono::seconds(5), [this] { return req_done_; })) return -EIO;
    return req_result_;
}

int32_t InputThread::request_set_relative(bool on) {
    std::unique_lock<std::mutex> lock(mu_);
    if (!started_) return -EIO;
    if (request_ != Request::None) return -EBUSY;
    req_relative_ = on;
    req_result_ = 0;
    req_done_ = false;
    request_ = Request::SetRelative;
    work_cv_.notify_all();
    if (!done_cv_.wait_for(lock, std::chrono::seconds(5), [this] { return req_done_; })) return -EIO;
    return req_result_;
}

void InputThread::set_poster(const tension_core_api *api, uint32_t source_id) {
    api_.store(api, std::memory_order_release);
    source_id_.store(source_id, std::memory_order_release);
}

// ── the public verbs' thread-side calls ─────────────────────────────────

int32_t InputThread::attach(uint32_t kind, uint64_t token) { return request_attach(kind, token); }
int32_t InputThread::detach() { return request_detach(); }
int32_t InputThread::set_relative(bool on) { return request_set_relative(on); }
int32_t InputThread::retry_sdl() { return request_retry_sdl(); }

} // namespace tension_input
