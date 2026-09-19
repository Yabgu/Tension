// The status mirror — see status.h for why it exists.

#include "status.h"

#include <cstring>

namespace tension_ogre {
namespace {

/// Copy at most `cap - 1` bytes plus a terminator, so a truncated message is
/// still a C string.
void store(char *dst, size_t cap, uint32_t &len, const std::string &message) {
    const size_t n = message.size() < cap - 1 ? message.size() : cap - 1;
    std::memcpy(dst, message.data(), n);
    dst[n] = '\0';
    len = static_cast<uint32_t>(n);
}

} // namespace

void StatusWriter::set_state(uint32_t state) {
    std::lock_guard<std::mutex> lock(mutex_);
    state_.state = state;
    dirty_ = true;
}

void StatusWriter::set_stage(uint32_t stage) {
    std::lock_guard<std::mutex> lock(mutex_);
    state_.stage = stage;
    dirty_ = true;
}

void StatusWriter::set_window(uint32_t width, uint32_t height) {
    std::lock_guard<std::mutex> lock(mutex_);
    state_.window_w = width;
    state_.window_h = height;
    dirty_ = true;
}

void StatusWriter::note_frame() {
    std::lock_guard<std::mutex> lock(mutex_);
    state_.frames += 1;
    dirty_ = true;
}

void StatusWriter::set_frames(uint64_t frames) {
    std::lock_guard<std::mutex> lock(mutex_);
    state_.frames = frames;
    dirty_ = true;
}

void StatusWriter::set_error(uint32_t stage, int32_t error, const std::string &message) {
    std::lock_guard<std::mutex> lock(mutex_);
    state_.state = TENSION_OGRE_RES_STATE_FAILED;
    state_.stage = stage;
    state_.error = error;
    store(message_, sizeof(message_), message_len_, message);
    dirty_ = true;
}

void StatusWriter::note_message(const std::string &message) {
    std::lock_guard<std::mutex> lock(mutex_);
    store(message_, sizeof(message_), message_len_, message);
}

bool StatusWriter::dirty() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return dirty_;
}

StatusWriter::Snapshot StatusWriter::snapshot() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return state_;
}

void StatusWriter::clear_dirty() {
    std::lock_guard<std::mutex> lock(mutex_);
    dirty_ = false;
}

int32_t StatusWriter::message_length() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return message_len_ == 0 ? -1 : static_cast<int32_t>(message_len_);
}

int32_t StatusWriter::take_message(char *dst, size_t cap) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (message_len_ == 0 || dst == nullptr || cap == 0) return -1;
    const size_t n = message_len_ < cap ? message_len_ : cap;
    std::memcpy(dst, message_, n);
    message_len_ = 0;
    message_[0] = '\0';
    return static_cast<int32_t>(n);
}

} // namespace tension_ogre
