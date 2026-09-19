// config_test.cpp — the ogre config decoder's unit test.
//
// Standalone on purpose: the decoder includes no OGRE header, so this test
// needs nothing but a C++ compiler.
//
//   g++ -std=c++17 -Iinclude -Isrc src/config.cpp tests/config_test.cpp
//       -o build/config_test && ./build/config_test
//
// (The adapter round wires this into tension-ogre/build.sh; today it is the
// small standalone runner the plan called for.)
//
// The bytes are hand-built here the way the AS encoder writes them
// (tension-framework/assembly/runtime/tlv.ts):
//
//   u32 entry_count, then per entry: u32 key, u8 tag (2), i64 value LE
//
// `test_golden_bytes` decodes a stream pinned as a literal, so the layout is
// asserted rather than only produced by this file's own builder.

#include "../src/config.h"
#include "../include/tension_ogre.h"

#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>

using tension_ogre::Config;
using tension_ogre::ConfigDecodeResult;
using tension_ogre::ConfigError;

namespace {

int failures = 0;
int checks = 0;

void check(bool ok, const std::string &what) {
    ++checks;
    if (!ok) {
        ++failures;
        std::printf("  FAIL %s\n", what.c_str());
    }
}

void check_eq(uint32_t got, uint32_t want, const std::string &what) {
    ++checks;
    if (got != want) {
        ++failures;
        std::printf("  FAIL %s: got %u, want %u\n", what.c_str(), got, want);
    }
}

/// The encoder, written the way the guest SDK writes it.
struct Builder {
    std::vector<uint8_t> bytes;

    Builder() : bytes(4, 0) {}

    Builder &u32_at(size_t at, uint32_t v) {
        bytes[at] = static_cast<uint8_t>(v);
        bytes[at + 1] = static_cast<uint8_t>(v >> 8);
        bytes[at + 2] = static_cast<uint8_t>(v >> 16);
        bytes[at + 3] = static_cast<uint8_t>(v >> 24);
        return *this;
    }

    Builder &entry(uint32_t key, uint64_t value, uint8_t tag = 2) {
        const size_t at = bytes.size();
        bytes.resize(at + 13, 0);
        u32_at(at, key);
        bytes[at + 4] = tag;
        for (int i = 0; i < 8; ++i) bytes[at + 5 + static_cast<size_t>(i)] = static_cast<uint8_t>(value >> (8 * i));
        return *this;
    }

    /// Count must be patched last: entries are appended after it.
    std::vector<uint8_t> done(uint32_t count = 0xFFFFFFFFu) {
        const uint32_t entries = count == 0xFFFFFFFFu ? static_cast<uint32_t>((bytes.size() - 4) / 13) : count;
        u32_at(0, entries);
        return bytes;
    }
};

ConfigDecodeResult decode(const std::vector<uint8_t> &bytes) {
    return tension_ogre::decode_config(bytes.data(), bytes.size());
}

/// Every key at a legal value, plus the defaults for what is absent.
void test_full_round_trip() {
    std::printf("test_full_round_trip\n");
    Builder b;
    b.entry(TENSION_OGRE_KEY_ABI_VERSION, 1)
        .entry(TENSION_OGRE_KEY_RENDERER, TENSION_OGRE_RENDERER_NULL)
        .entry(TENSION_OGRE_KEY_HEADLESS, 1)
        .entry(TENSION_OGRE_KEY_VSYNC, 1)
        .entry(TENSION_OGRE_KEY_FRAME_HZ, 30)
        .entry(TENSION_OGRE_KEY_WINDOW_WIDTH, 640)
        .entry(TENSION_OGRE_KEY_WINDOW_HEIGHT, 480);
    const auto result = decode(b.done());
    check(result.ok, "decodes");
    check_eq(result.config.abi_version, 1, "abi_version");
    check_eq(result.config.renderer, TENSION_OGRE_RENDERER_NULL, "renderer");
    check(result.config.headless, "headless");
    check(result.config.vsync, "vsync");
    check_eq(result.config.frame_hz, 30, "frame_hz");
    check_eq(result.config.window_width, 640, "window_width");
    check_eq(result.config.window_height, 480, "window_height");
}

/// A missing optional key takes this build's default, not zero.
void test_defaults_for_absent_keys() {
    std::printf("test_defaults_for_absent_keys\n");
    Builder b;
    b.entry(TENSION_OGRE_KEY_ABI_VERSION, 1);
    const auto result = decode(b.done());
    check(result.ok, "abi_version alone is a legal config");
    check_eq(result.config.renderer, TENSION_OGRE_RENDERER_GL3PLUS, "renderer defaults to GL3+");
    check(!result.config.headless, "headless defaults to off");
    check(!result.config.vsync, "vsync defaults to off");
    check_eq(result.config.frame_hz, 60, "frame_hz defaults to 60");
    check_eq(result.config.window_width, 1280, "window_width defaults to 1280");
    check_eq(result.config.window_height, 720, "window_height defaults to 720");
}

/// The wire itself, pinned as literals: count, then 13 bytes per entry.
void test_golden_bytes() {
    std::printf("test_golden_bytes\n");
    const uint8_t golden[] = {
        0x02, 0x00, 0x00, 0x00,                                     // entry_count = 2
        0x01, 0x00, 0x00, 0x00, 0x02, 0x01, 0, 0, 0, 0, 0, 0, 0,     // abi_version = 1
        0x05, 0x00, 0x00, 0x00, 0x02, 0x1e, 0, 0, 0, 0, 0, 0, 0,     // frame_hz = 30
    };
    check(sizeof(golden) == 4 + 2 * 13, "13 bytes per entry");
    const auto result = tension_ogre::decode_config(golden, sizeof(golden));
    check(result.ok, "golden stream decodes");
    check_eq(result.config.abi_version, 1, "golden abi_version");
    check_eq(result.config.frame_hz, 30, "golden frame_hz");
}

/// A repeated key takes its last value, the way both decoders read the argmap.
void test_duplicate_key_takes_last() {
    std::printf("test_duplicate_key_takes_last\n");
    Builder b;
    b.entry(TENSION_OGRE_KEY_ABI_VERSION, 1)
        .entry(TENSION_OGRE_KEY_FRAME_HZ, 30)
        .entry(TENSION_OGRE_KEY_FRAME_HZ, 144);
    const auto result = decode(b.done());
    check(result.ok, "duplicate key is not a refusal");
    check_eq(result.config.frame_hz, 144, "last value wins");
}

void expect_refusal(const std::vector<uint8_t> &bytes, ConfigError want, uint32_t want_key,
                    const std::string &what) {
    ++checks;
    const auto result = decode(bytes);
    if (result.ok || result.error != want || result.error_key != want_key) {
        ++failures;
        std::printf("  FAIL %s: got %s (key %u), want %s (key %u)\n", what.c_str(),
                    result.error_name(), result.error_key, tension_ogre::config_error_name(want),
                    want_key);
    }
}

void test_refusals() {
    std::printf("test_refusals\n");

    expect_refusal({}, ConfigError::Truncated, 0, "empty buffer");
    expect_refusal({0x01, 0x00}, ConfigError::Truncated, 0, "a count with no room to grow");

    // Count says two entries, the bytes carry one.
    Builder short_stream;
    short_stream.entry(TENSION_OGRE_KEY_ABI_VERSION, 1);
    expect_refusal(short_stream.done(2), ConfigError::Truncated, 0, "stream ends inside an entry");

    Builder not_first;
    not_first.entry(TENSION_OGRE_KEY_RENDERER, 1).entry(TENSION_OGRE_KEY_ABI_VERSION, 1);
    expect_refusal(not_first.done(), ConfigError::AbiVersionNotFirst, TENSION_OGRE_KEY_RENDERER,
                   "first entry must be abi_version");

    Builder wrong_abi;
    wrong_abi.entry(TENSION_OGRE_KEY_ABI_VERSION, 2);
    expect_refusal(wrong_abi.done(), ConfigError::AbiVersion, TENSION_OGRE_KEY_ABI_VERSION,
                   "abi_version 2 is not this build's");

    Builder unknown;
    unknown.entry(TENSION_OGRE_KEY_ABI_VERSION, 1).entry(8, 1);
    expect_refusal(unknown.done(), ConfigError::UnknownKey, 8, "unknown key");

    Builder bad_tag;
    bad_tag.entry(TENSION_OGRE_KEY_ABI_VERSION, 1).entry(TENSION_OGRE_KEY_VSYNC, 1, 3);
    expect_refusal(bad_tag.done(), ConfigError::MalformedTag, TENSION_OGRE_KEY_VSYNC, "tag 3");

    Builder overflow;
    overflow.entry(TENSION_OGRE_KEY_ABI_VERSION, 1).entry(TENSION_OGRE_KEY_FRAME_HZ, 1ull << 32);
    expect_refusal(overflow.done(), ConfigError::ValueOverflow, TENSION_OGRE_KEY_FRAME_HZ,
                   "value wider than 32 bits");

    Builder trailing;
    {
        auto bytes = trailing.entry(TENSION_OGRE_KEY_ABI_VERSION, 1).done();
        bytes.push_back(0x00);
        expect_refusal(bytes, ConfigError::TrailingBytes, 0, "trailing byte");
    }

    Builder empty_count;
    expect_refusal(empty_count.done(0), ConfigError::MissingKey, TENSION_OGRE_KEY_ABI_VERSION,
                   "no entries at all");

    Builder too_many;
    too_many.entry(TENSION_OGRE_KEY_ABI_VERSION, 1);
    {
        auto bytes = too_many.done(33);
        expect_refusal(bytes, ConfigError::ValueOutOfRange, 0, "more entries than the limit");
    }

    struct Range {
        uint32_t key;
        uint64_t value;
    };
    const Range ranges[] = {
        {TENSION_OGRE_KEY_RENDERER, 9},
        {TENSION_OGRE_KEY_HEADLESS, 2},
        {TENSION_OGRE_KEY_VSYNC, 7},
        {TENSION_OGRE_KEY_FRAME_HZ, 0},
        {TENSION_OGRE_KEY_FRAME_HZ, 1001},
        {TENSION_OGRE_KEY_WINDOW_WIDTH, 0},
        {TENSION_OGRE_KEY_WINDOW_HEIGHT, 20000},
    };
    for (const Range &range : ranges) {
        Builder b;
        b.entry(TENSION_OGRE_KEY_ABI_VERSION, 1).entry(range.key, range.value);
        expect_refusal(b.done(), ConfigError::ValueOutOfRange, range.key,
                       std::string("range: ") + tension_ogre::config_key_name(range.key));
    }
}

void test_key_names() {
    std::printf("test_key_names\n");
    check(std::string(tension_ogre::config_key_name(TENSION_OGRE_KEY_RENDERER)) == "renderer",
          "key 2 is `renderer`");
    check(std::string(tension_ogre::config_key_name(99)) == "<unknown>", "unknown key names itself");
    check(std::string(tension_ogre::config_error_name(ConfigError::UnknownKey)) == "unknown-key",
          "the error token");
}

} // namespace

int main() {
    test_full_round_trip();
    test_defaults_for_absent_keys();
    test_golden_bytes();
    test_duplicate_key_takes_last();
    test_refusals();
    test_key_names();

    std::printf("%d checks, %d failures\n", checks, failures);
    return failures == 0 ? 0 : 1;
}
