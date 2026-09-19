// The status mirror: what the render thread has to say, and the only channel
// it has to say it through.
//
// The render thread never touches guest memory (tension_adapter.h rule 2: "never
// touch guest memory outside publish, apply, or an import call; never from a
// background thread"). It writes here instead; the `publish` hook — which runs
// on the interpreter thread, inside a session verb, with guest memory available
// — copies a snapshot into the renderer's `Resource` record. One mutex is the
// whole contract, and every method is safe from any thread.

#ifndef TENSION_OGRE_STATUS_H
#define TENSION_OGRE_STATUS_H

#include <cstddef>
#include <cstdint>
#include <mutex>
#include <string>

#include "../include/tension_ogre.h"

namespace tension_ogre {

/// The message buffer's size, as the plan fixes it: long enough for a real
/// diagnostic, short enough to live in a static without a heap.
constexpr size_t kMessageBytes = 256;

class StatusWriter {
  public:
    /// What the publish hook copies into the record, in one lock.
    struct Snapshot {
        uint32_t state = TENSION_OGRE_RES_STATE_REQUESTED;
        uint32_t stage = TENSION_OGRE_STAGE_PLUGIN;
        int32_t error = 0;
        uint32_t window_w = 0;
        uint32_t window_h = 0;
        uint64_t frames = 0;
    };

    // ── the render thread ────────────────────────────────────────────────

    void set_state(uint32_t state);
    void set_stage(uint32_t stage);
    void set_window(uint32_t width, uint32_t height);
    /// One frame rendered: the counter the guest reads as liveness.
    void note_frame();
    void set_frames(uint64_t frames);

    /// Record a failure: `FAILED`, this stage, this errno, this message. The
    /// message is also what `last_error` hands the guest.
    void set_error(uint32_t stage, int32_t error, const std::string &message);

    /// Record a message without claiming the renderer failed — for a config
    /// refused before any thread existed, which the guest learns about from
    /// `init`'s return value rather than from the record.
    void note_message(const std::string &message);

    // ── the publish hook, and `last_error` ───────────────────────────────

    /// Whether the record the guest reads would change if publish ran now.
    bool dirty() const;

    Snapshot snapshot() const;

    /// Called by publish once the snapshot has reached guest memory.
    void clear_dirty();

    /// `last_error`'s probe: the message's length, without consuming it.
    /// `-1` when there is nothing to report.
    int32_t message_length() const;

    /// `last_error`'s consume: copy up to `cap` bytes into `dst`, take the
    /// message, and return the byte count written. `-1` when empty.
    int32_t take_message(char *dst, size_t cap);

  private:
    mutable std::mutex mutex_;
    Snapshot state_;
    bool dirty_ = false;
    char message_[kMessageBytes] = {};
    uint32_t message_len_ = 0;
};

} // namespace tension_ogre

#endif // TENSION_OGRE_STATUS_H
