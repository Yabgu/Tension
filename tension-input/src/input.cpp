// The input capability's mirror: what the host's dispatcher says, as state.
//
// This file used to be the SDL thread. It is now the translation from one
// `tension_event` batch into the two things a guest reads — the state record and
// the two edge classes — and it contains no SDL call, no thread, and no window.
//
// Two measured rules came across from the thread model unchanged, because they
// are about SDL's data, not about who polls it. A third did not survive
// measurement and is stated here as what the code does now:
//   * the device id is carried on the wire for producers that want it, and this
//     mirror does **not** gate on it: SDL 3's X11 backend sends ordinary motion
//     with `which == 0`, so gating froze the pointer at 0,0 (v7b, measured);
//   * the first `kAttachSettleMs` of *motion deltas* after an attach is the
//     window and the pointer-confinement settling, and is dropped too — the
//     position is still updated, because it is a fact about the pointer;
//   * motion is accumulated, never posted — one delta per snapshot, because a
//     1 kHz device against a 64-slot ring is a statistic, not a stream.
//
// The fourth rule is new and is the whole point of the pass: every sample the
// host hands over is added to the accumulator before anything else can look at
// it, so the total a guest sees depends on the device's displacement and not on
// the guest's frame rate.
//
// Two things arrived with the editor that need a shape this mirror did not have:
// **modifiers** are a level (the set held after the last key transition, so the
// record carries it) and **typed text** is a flow (UTF-8, consumed by reading,
// so it is a verb and not a field). Neither needs SDL here: the host translates
// its own `SDL_Keymod` word into the wire's bits, and the bytes it forwards are
// already UTF-8.

#include "input.h"

#include <chrono>
#include <cmath>
#include <cstring>
#include <string>

namespace tension_input {

uint64_t now_ms() {
    using namespace std::chrono;
    return static_cast<uint64_t>(
        duration_cast<milliseconds>(steady_clock::now().time_since_epoch()).count());
}

namespace {

/// The f32 the host packed into a payload word, as an f32.
///
/// The wire carries the delta's and the wheel's floats as their bit patterns in
/// `a2`/`a3` (platform.rs's translation site is the argument: "the delta is not
/// rounded", and an integer payload would round it before the accumulator ever
/// saw it).
float float_from_bits(int64_t bits) {
    const uint32_t word = static_cast<uint32_t>(static_cast<uint64_t>(bits) & 0xFFFF'FFFFu);
    float value = 0.0f;
    std::memcpy(&value, &word, sizeof(value));
    return value;
}

} // namespace

void Mirror::set_poster(const tension_core_api *api, uint32_t source_id) {
    api_.store(api, std::memory_order_release);
    source_id_.store(source_id, std::memory_order_release);
}

void Mirror::attach(uint64_t now) {
    {
        std::lock_guard<std::mutex> lock(mu_);
        std::memset(keys_held_, 0, sizeof(keys_held_));
        mouse_buttons_ = 0;
        modifiers_ = 0;
        text_len_ = 0;
        accum_dx_ = accum_dy_ = accum_wheel_x_ = accum_wheel_y_ = 0.0f;
        discard_motion_until_ms_ = now + kAttachSettleMs;
    }
    relative_.store(false, std::memory_order_release);
    focused_.store(false, std::memory_order_release);
    pointer_over_.store(false, std::memory_order_release);
    attached_.store(true, std::memory_order_release);
}

void Mirror::detach() {
    attached_.store(false, std::memory_order_release);
    relative_.store(false, std::memory_order_release);
    focused_.store(false, std::memory_order_release);
    pointer_over_.store(false, std::memory_order_release);
    std::lock_guard<std::mutex> lock(mu_);
    mouse_buttons_ = 0;
    modifiers_ = 0;
    text_len_ = 0;
    std::memset(keys_held_, 0, sizeof(keys_held_));
    accum_dx_ = accum_dy_ = accum_wheel_x_ = accum_wheel_y_ = 0.0f;
    discard_motion_until_ms_ = 0;
}

void Mirror::ingest(const tension_event *events, uint32_t count, uint64_t now) {
    if (events == nullptr) return;
    for (uint32_t index = 0; index < count; ++index) {
        const tension_event &event = events[index];
        switch (event.family) {
            case TENSION_EVENT_KEY: {
                const bool down = (event.flags & TENSION_KEY_FLAG_DOWN) != 0;
                const uint32_t scancode = static_cast<uint32_t>(event.a0);
                const uint32_t keycode = static_cast<uint32_t>(event.a1);
                uint32_t flags = down ? TENSION_INPUT_KEY_DOWN : 0u;
                if ((event.flags & TENSION_KEY_FLAG_REPEAT) != 0 || event.a3 != 0)
                    flags |= TENSION_INPUT_KEY_REPEAT;
                if (keycode == 0 && scancode == 0) flags |= TENSION_INPUT_KEY_SYNTHETIC;
                {
                    std::lock_guard<std::mutex> lock(mu_);
                    if (scancode < 256) {
                        if (down) keys_held_[scancode >> 5] |= (1u << (scancode & 31));
                        else keys_held_[scancode >> 5] &= ~(1u << (scancode & 31));
                    }
                    // `a2` is the modifier set *after* this transition, so the
                    // last key event this mirror sees is the current set — both
                    // halves of a pair carry it, which is what makes "the
                    // modifiers held now" a matter of copying rather than of
                    // tracking which key owns which bit.
                    modifiers_ = static_cast<uint32_t>(event.a2) & TENSION_INPUT_MOD_KNOWN;
                }
                // The wire is `a` = keycode, `b` = scancode — the order v1's
                // records already had, kept so a guest's decoder does not move.
                post(TENSION_INPUT_CLASS_INPUT_KEY, flags, keycode, scancode, 0.0f, 0.0f);
                break;
            }
            case TENSION_EVENT_MOUSE_MOTION: {
                // The pointer's position is the pointer's, whatever device id
                // the event carries. SDL 3's X11 backend reports ordinary device
                // motion with `which == 0`: measured on this rig, every event
                // from an injected move carried device id 0 *and* a real
                // position *and* a real delta, so gating on the device id froze
                // `mouse_x`/`mouse_y` at 0,0 and made every guest's hit-testing
                // impossible. That is what the filter this replaces was doing.
                //
                // What the filter was *for* survives: motion that is not the
                // device's is the position shifting under a stationary pointer
                // (a window moved, or a warp), and SDL reports that with a zero
                // delta — which the accumulator absorbs by adding nothing. The
                // one genuinely enormous delta, the relative-mode warp that
                // follows an attach, is `kAttachSettleMs`'s job below.
                const int32_t x = static_cast<int32_t>(event.a0);
                const int32_t y = static_cast<int32_t>(event.a1);
                std::lock_guard<std::mutex> lock(mu_);
                mouse_x_ = x;
                mouse_y_ = y;
                if (now < discard_motion_until_ms_) break;
                accum_dx_ += float_from_bits(event.a2);
                accum_dy_ += float_from_bits(event.a3);
                break;
            }
            case TENSION_EVENT_MOUSE_BUTTON: {
                const bool down = event.a1 != 0;
                const uint32_t mask = static_cast<uint32_t>(event.a3);
                {
                    std::lock_guard<std::mutex> lock(mu_);
                    mouse_buttons_ = mask;
                }
                uint32_t flags = TENSION_INPUT_MOUSE_SHAPE_BUTTON;
                if (down) flags |= TENSION_INPUT_MOUSE_BUTTON_DOWN;
                post(TENSION_INPUT_CLASS_INPUT_MOUSE, flags,
                     static_cast<uint32_t>(event.a0), mask, 0.0f, 0.0f);
                break;
            }
            case TENSION_EVENT_MOUSE_WHEEL: {
                // `a0`/`a1` are the integer direction (y, x), `a2`/`a3` the f32
                // bit patterns (y, x). The state record accumulates the floats;
                // the edge carries both, as it always has.
                const float x = float_from_bits(event.a3);
                const float y = float_from_bits(event.a2);
                {
                    std::lock_guard<std::mutex> lock(mu_);
                    accum_wheel_x_ += x;
                    accum_wheel_y_ += y;
                }
                post(TENSION_INPUT_CLASS_INPUT_MOUSE, TENSION_INPUT_MOUSE_SHAPE_WHEEL, 0, 0, x, y);
                break;
            }
            case TENSION_EVENT_WINDOW: {
                switch (static_cast<uint32_t>(event.a0)) {
                    case TENSION_WINDOW_EVENT_FOCUS_GAINED:
                        focused_.store(true, std::memory_order_release);
                        break;
                    case TENSION_WINDOW_EVENT_FOCUS_LOST: {
                        focused_.store(false, std::memory_order_release);
                        // **A modifier held across a focus change never gets a
                        // key-up.** The user holds Ctrl, alt-tabs, releases it
                        // in the other window; this mirror would keep CTRL set
                        // forever and turn every later click into Ctrl+click.
                        // So losing focus forgets the modifier set — the one
                        // place it is not simply what the last key event said.
                        std::lock_guard<std::mutex> lock(mu_);
                        modifiers_ = 0;
                        break;
                    }
                    case TENSION_WINDOW_EVENT_MOUSE_ENTER:
                        pointer_over_.store(true, std::memory_order_release);
                        break;
                    case TENSION_WINDOW_EVENT_MOUSE_LEAVE:
                        pointer_over_.store(false, std::memory_order_release);
                        break;
                    default:
                        // RESIZED and friends are window facts, not input
                        // state: `window_info` is where a guest reads them.
                        break;
                }
                break;
            }
            case TENSION_EVENT_TEXT: {
                // The payload is `flags` UTF-8 bytes inline in `a0..a3`
                // (`TENSION_EVENT_TEXT_BYTES`, little-endian within each word).
                // Nothing is interpreted here: the bytes are appended exactly as
                // the host encoded them, because a text field wants what the
                // keyboard produced and a mirror is not the place to re-encode
                // it.
                const size_t count = static_cast<size_t>(event.flags);
                if (count == 0 || count > TENSION_EVENT_TEXT_BYTES) break;
                const int64_t words[4] = {event.a0, event.a1, event.a2, event.a3};
                std::lock_guard<std::mutex> lock(mu_);
                for (size_t index = 0; index < count; ++index) {
                    const int64_t word = words[index / 8];
                    const char byte = static_cast<char>((static_cast<uint64_t>(word) >>
                                                         ((index % 8) * 8)) &
                                                        0xFFu);
                    if (text_len_ >= kTextCapacity) {
                        // Counted, and said once per 256 refusals: a guest that
                        // stopped reading is a fact the log should carry, and a
                        // line per keystroke is the same fact 60 times a second.
                        if (dropped_text_++ % 256 == 0) {
                            input_log("input: text buffer full; " +
                                      std::to_string(dropped_text_) + " byte(s) dropped");
                        }
                        break;
                    }
                    text_[text_len_++] = byte;
                }
                break;
            }
            default:
                // QUIT and PAD carry nothing this capability's state keeps. Pads
                // are read from `pad_state`; a pad *edge* has no class in the
                // session yet (`docs/modules/input.md` §2).
                break;
        }
    }
}

uint32_t Mirror::flags() const {
    uint32_t flags = 0;
    if (attached_.load(std::memory_order_acquire)) flags |= TENSION_INPUT_STATE_ATTACHED;
    if (relative_.load(std::memory_order_acquire)) flags |= TENSION_INPUT_STATE_RELATIVE;
    if (focused_.load(std::memory_order_acquire)) flags |= TENSION_INPUT_STATE_FOCUSED;
    if (pointer_over_.load(std::memory_order_acquire)) flags |= TENSION_INPUT_STATE_POINTER_OVER;
    return flags;
}

void Mirror::snapshot(StateRecord *out, uint32_t pads_present) {
    std::lock_guard<std::mutex> lock(mu_);
    std::memset(out, 0, sizeof(*out));
    out->version = TENSION_INPUT_STATE_VERSION;
    out->flags = flags();
    out->pads_present = pads_present;
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
    out->modifiers = modifiers_;
    out->wheel_x = accum_wheel_x_;
    out->wheel_y = accum_wheel_y_;
    accum_wheel_x_ = 0.0f;
    accum_wheel_y_ = 0.0f;
    // The highest sequence an edge this mirror posted came back with. Motion
    // never posts, so this is the last edge's — which is what it always was.
    out->seq = last_seq_;
}

int32_t Mirror::take_text(char *out, int32_t cap) {
    std::lock_guard<std::mutex> lock(mu_);
    const int32_t pending = static_cast<int32_t>(text_len_);
    if (cap <= 0) return pending; /* the probe: the size, nothing consumed */
    if (cap < pending) return kTextShort; /* short buffer: nothing consumed */
    if (pending > 0 && out != nullptr) {
        std::memcpy(out, text_, static_cast<size_t>(pending));
        text_len_ = 0;
    }
    return pending;
}

bool Mirror::subscribed(uint32_t class_id) const {
    const tension_core_api *api = api_.load(std::memory_order_acquire);
    if (api == nullptr || api->class_info == nullptr) return true;
    uint32_t mode = 0, capacity = 0, flags = 0;
    if (api->class_info(api->user, class_id, &mode, &capacity, &flags) != 0) return true;
    return (flags & kClassFlagSubscribed) != 0;
}

void Mirror::post(uint32_t class_id, uint32_t flags, uint32_t a, uint32_t b, float f0, float f1) {
    const tension_core_api *api = api_.load(std::memory_order_acquire);
    if (api == nullptr || api->post_event == nullptr) return;
    if (!subscribed(class_id)) return; /* a producer may skip work nobody asked for */
    uint64_t seq = 0;
    const int32_t rc =
        api->post_event(api->user, source_id_.load(std::memory_order_relaxed), class_id, flags, a, b,
                        f0, f1, &seq);
    if (rc != 0) {
        // The ring is full. A producer cannot wait for it (dispatch must not
        // block, rule 13), so the edge is dropped and the drop is *said*. One
        // line per class per 1024 drops: an edge stream that stalls is a fact
        // the log should carry, and a line per event would be the same fact
        // 60 times a second.
        std::lock_guard<std::mutex> lock(mu_);
        uint32_t &dropped = (class_id == TENSION_INPUT_CLASS_INPUT_KEY) ? dropped_keys_
                                                                       : dropped_mouse_;
        dropped++;
        if (dropped == 1 || dropped % 1024 == 0) {
            input_log("input: class " + std::to_string(class_id) + " refused an edge (" +
                      std::to_string(rc) + "); " + std::to_string(dropped) + " dropped so far");
        }
        return;
    }
    if (seq != 0) {
        std::lock_guard<std::mutex> lock(mu_);
        if (seq > last_seq_) last_seq_ = seq;
    }
}

} // namespace tension_input
