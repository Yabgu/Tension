// The input capability's internal types: the two wire records as C++ sees them,
// and the mirror it keeps of what the host dispatches.
//
// **There is no SDL here any more, and no thread.** Before v7 this file declared
// a thread that owned `SDL_Init`, a window, and a 2 ms poll loop; the whole of it
// is gone. The host initialises the video subsystem, owns the
// window, and pumps the queue on the thread that did so — and this capability
// subscribes a *layer* and is handed a batch of events, synchronously, once per
// pump (thread rule 13 in tension_adapter.h).
//
// What that costs: events arrive once per pump instead of once per 2 ms poll, so
// the fidelity of a fast flick depends on the host draining the queue and on
// nothing in this file dropping a sample. What it buys: one SDL, one event
// queue, one thread allowed to touch either.

#ifndef TENSION_INPUT_INTERNAL_H
#define TENSION_INPUT_INTERNAL_H

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <mutex>
#include <string>

#include "tension_adapter.h" /* the core API type the layer posts through */
#include "tension_input.h"

namespace tension_input {

/// One line on the `input` logger, implemented by the adapter, which owns the
/// API table.
void input_log(const std::string &message);

/// `class_info`'s flags word, bit 0: the class has a subscriber, so a producer
/// that can skip work nobody asked for should keep producing
/// (tension-core/src/session/arena.rs, `CLASS_FLAG_SUBSCRIBED`).
constexpr uint32_t kClassFlagSubscribed = 1u << 0;

/// How long after a successful attach motion events are discarded: they are the
/// window settling under the pointer and the confinement warp, not input.
/// Measured at 137 ms and 343 ms, so half a second covers both
/// (`docs/modules/input.md` §5).
///
/// Unchanged by v7, and still needed: attaching is immediately followed by a
/// relative-mode request in every real use, and the warp that produces is one
/// enormous delta no consumer wants.
constexpr uint32_t kAttachSettleMs = 500;

/// The state record (`docs/modules/input.md` §2). Offsets are the wire; the
/// static_assert below is what keeps this struct and the header's table from
/// drifting apart.
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
    uint32_t modifiers; /* TENSION_INPUT_MOD_*, offset 88 */
    uint32_t reserved;
};
static_assert(sizeof(StateRecord) == TENSION_INPUT_STATE_SIZE,
              "the state record is the size the wire declares");
static_assert(offsetof(StateRecord, mouse_dxf) == 56,
              "the float delta is where the guest reads it");
static_assert(offsetof(StateRecord, modifiers) == 88,
              "the modifier word is where the guest reads it");

/// The gamepad slot record (`docs/modules/input.md` §2; v1's state half).
///
/// An alias, not a definition: the layout moved to `tension_adapter.h` at ABI v7
/// when `pad_state` made the record the boundary's instead of this capability's
/// private wire. Keeping one definition is what stops the two drifting; the
/// assertion below still pins the size either way.
using PadRecord = tension_pad_record;
static_assert(sizeof(PadRecord) == TENSION_INPUT_PAD_SIZE,
              "the pad record is the size the wire declares");

/// Monotonic milliseconds, for the attach-settle window.
uint64_t now_ms();

/// The capability's state, updated from dispatcher batches and read by the
/// verbs.
///
/// One mutex, held for the length of a batch and for the length of a snapshot.
/// Both run on the same thread — the host dispatches on the window's thread and
/// the guest calls verbs on it — so the lock is never contended; it exists
/// because "same thread today" is not a property the type can check.
///
/// **Motion is accumulated, never posted.** A 1 kHz device against a 64-slot
/// ring is a statistic, not a stream: the state record carries one delta per
/// snapshot, and a snapshot consumes it (`docs/modules/input.md` §5, measured at
/// 989 events in one second).
class Mirror {
  public:
    Mirror() = default;
    Mirror(const Mirror &) = delete;
    Mirror &operator=(const Mirror &) = delete;

    /// Where edges are posted from; set once at `link`.
    void set_poster(const tension_core_api *api, uint32_t source_id);

    /// The guest attached: clear the held state and arm the settle window.
    void attach(uint64_t now_ms);

    /// The guest detached, or closed: forget what was held.
    void detach();

    /// What the capability last asked the host for.
    void set_relative(bool on) { relative_.store(on, std::memory_order_release); }

    /// One batch from the dispatcher. Edges are posted; motion accumulates.
    void ingest(const tension_event *events, uint32_t count, uint64_t now_ms);

    /// Compose one state record and consume the motion it carries.
    void snapshot(StateRecord *out, uint32_t pads_present);

    /// The text typed since the previous call: copy up to `cap` bytes into
    /// `out` and return how many, or the pending count when `cap <= 0`.
    ///
    /// A `cap` smaller than the pending count copies **nothing** and returns
    /// `kTextShort`: the caller measured with a probe, so a short buffer is a
    /// caller bug that must not silently eat a keystroke. The text stays
    /// pending until it is actually read out.
    int32_t take_text(char *out, int32_t cap);

    /// A refusal from `take_text`: the buffer was too small, nothing consumed.
    static constexpr int32_t kTextShort = -28; /* -ENOSPC */

    /// The largest text one frame can hold before it is dropped and counted.
    /// 256 bytes is ~16 frames of fast typing at 60 Hz, so a guest reading once
    /// per frame never reaches it; a guest that stopped reading gets a counted
    /// loss rather than a silent one (`dropped_text`).
    static constexpr size_t kTextCapacity = 256;

    /// The state record's `flags`, from what the mirror has seen.
    uint32_t flags() const;

    bool attached() const { return attached_.load(std::memory_order_acquire); }

  private:
    void post(uint32_t class_id, uint32_t flags, uint32_t a, uint32_t b, float f0, float f1);
    bool subscribed(uint32_t class_id) const;

    mutable std::mutex mu_;

    // ── guarded by mu_ ──────────────────────────────────────────────────
    uint32_t keys_held_[8] = {0};
    uint32_t mouse_buttons_ = 0;
    int32_t mouse_x_ = 0;
    int32_t mouse_y_ = 0;
    /// The modifier set after the last key transition (TENSION_INPUT_MOD_*).
    uint32_t modifiers_ = 0;
    /// UTF-8 typed since the last `take_text`, and how much of it is used.
    char text_[kTextCapacity] = {0};
    size_t text_len_ = 0;
    /// Text bytes refused because `text_` was full, and whether that has been
    /// said out loud (one log line per period of saturation, not per keystroke).
    uint32_t dropped_text_ = 0;
    float accum_dx_ = 0.0f;
    float accum_dy_ = 0.0f;
    float accum_wheel_x_ = 0.0f;
    float accum_wheel_y_ = 0.0f;
    uint64_t last_seq_ = 0;
    /// Edges the host's ring refused, per class. Counted rather than dropped
    /// silently: `post_event` answering -ENOSPC is the one failure a producer
    /// cannot retry, so it is the one worth counting.
    uint32_t dropped_keys_ = 0;
    uint32_t dropped_mouse_ = 0;
    /// Motion arriving before this instant is the attach settling, not input.
    uint64_t discard_motion_until_ms_ = 0;

    // ── written by the dispatcher, read by a snapshot ───────────────────
    std::atomic<bool> attached_{false};
    std::atomic<bool> relative_{false};
    std::atomic<bool> focused_{false};
    std::atomic<bool> pointer_over_{false};

    std::atomic<const tension_core_api *> api_{nullptr};
    std::atomic<uint32_t> source_id_{0};
};

} // namespace tension_input

#endif // TENSION_INPUT_INTERNAL_H
