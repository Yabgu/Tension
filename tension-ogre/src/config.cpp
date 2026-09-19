// The ogre config TLV decoder — see config.h for the wire and the policy.

#include "config.h"

#include "../include/tension_ogre.h"

#include <cstdio>

namespace tension_ogre {
namespace {

/// The only value tag this build reads, matching `config.rs`'s TAG_I64.
constexpr uint8_t kTagI64 = 2;

/// This build's own limits. They are refusals, not clamps: a frame rate is
/// either one the adapter can pace to or a mistake worth naming.
constexpr uint32_t kMaxEntries = 32;
constexpr uint32_t kMaxFrameHz = 1000;
constexpr uint32_t kMaxWindowPixels = 16384;

/// A cursor that never reads past the end and never throws.
struct Reader {
    const uint8_t *bytes;
    size_t len;
    size_t at = 0;

    bool has(size_t n) const { return len - at >= n; }

    uint8_t u8() {
        const uint8_t v = bytes[at];
        at += 1;
        return v;
    }

    uint32_t u32() {
        const uint32_t v = static_cast<uint32_t>(bytes[at]) |
                           (static_cast<uint32_t>(bytes[at + 1]) << 8) |
                           (static_cast<uint32_t>(bytes[at + 2]) << 16) |
                           (static_cast<uint32_t>(bytes[at + 3]) << 24);
        at += 4;
        return v;
    }

    /// The signed 64-bit value as the wire carries it; the caller checks that
    /// it fits the u32 the setters write.
    uint64_t u64() {
        uint64_t v = 0;
        for (int i = 7; i >= 0; --i) v = (v << 8) | bytes[at + static_cast<size_t>(i)];
        at += 8;
        return v;
    }
};

ConfigDecodeResult refuse(ConfigError error, uint32_t key, std::string message) {
    ConfigDecodeResult result;
    result.ok = false;
    result.error = error;
    result.error_key = key;
    result.message = std::move(message);
    return result;
}

/// Check one known key's value, with the key's name in the message.
bool in_range(uint32_t value, uint32_t low, uint32_t high) { return value >= low && value <= high; }

} // namespace

const char *config_error_name(ConfigError error) {
    switch (error) {
        case ConfigError::None: return "ok";
        case ConfigError::Truncated: return "truncated";
        case ConfigError::AbiVersionNotFirst: return "abi-version-not-first";
        case ConfigError::AbiVersion: return "abi-version";
        case ConfigError::UnknownKey: return "unknown-key";
        case ConfigError::MalformedTag: return "malformed-tag";
        case ConfigError::ValueOverflow: return "value-overflow";
        case ConfigError::TrailingBytes: return "trailing-bytes";
        case ConfigError::ValueOutOfRange: return "value-out-of-range";
        case ConfigError::MissingKey: return "missing-key";
    }
    return "unknown";
}

const char *config_key_name(uint32_t key) {
    switch (key) {
        case TENSION_OGRE_KEY_ABI_VERSION: return "abi_version";
        case TENSION_OGRE_KEY_RENDERER: return "renderer";
        case TENSION_OGRE_KEY_HEADLESS: return "headless";
        case TENSION_OGRE_KEY_VSYNC: return "vsync";
        case TENSION_OGRE_KEY_FRAME_HZ: return "frame_hz";
        case TENSION_OGRE_KEY_WINDOW_WIDTH: return "window_width";
        case TENSION_OGRE_KEY_WINDOW_HEIGHT: return "window_height";
        default: return "<unknown>";
    }
}

const char *ConfigDecodeResult::error_name() const { return config_error_name(error); }

ConfigDecodeResult decode_config(const uint8_t *bytes, size_t len) {
    if (bytes == nullptr || len < 4) {
        return refuse(ConfigError::Truncated, 0,
                      "malformed config: the stream ends before its entry count");
    }

    Reader reader{bytes, len};
    const uint32_t count = reader.u32();
    if (count > kMaxEntries) {
        char line[96];
        std::snprintf(line, sizeof(line),
                      "malformed config: %u entries is more than this build accepts (%u)", count,
                      kMaxEntries);
        return refuse(ConfigError::ValueOutOfRange, 0, line);
    }

    Config config;
    bool abi_seen = false;
    bool first = true;

    for (uint32_t index = 0; index < count; ++index) {
        if (!reader.has(4 + 1 + 8)) {
            return refuse(ConfigError::Truncated, 0,
                          "malformed config: the stream ends inside an entry");
        }
        const uint32_t key = reader.u32();
        if (first && key != TENSION_OGRE_KEY_ABI_VERSION) {
            return refuse(ConfigError::AbiVersionNotFirst, key,
                          "malformed config: the first entry must be `abi_version`");
        }
        first = false;

        const uint8_t tag = reader.u8();
        if (tag != kTagI64) {
            char line[96];
            std::snprintf(line, sizeof(line), "malformed config: key `%s` carries tag %u, not 2",
                          config_key_name(key), static_cast<unsigned>(tag));
            return refuse(ConfigError::MalformedTag, key, line);
        }

        const uint64_t raw = reader.u64();
        if ((raw >> 32) != 0) {
            char line[112];
            std::snprintf(line, sizeof(line),
                          "malformed config: key `%s` has a value wider than 32 bits",
                          config_key_name(key));
            return refuse(ConfigError::ValueOverflow, key, line);
        }
        const uint32_t value = static_cast<uint32_t>(raw);

        switch (key) {
            case TENSION_OGRE_KEY_ABI_VERSION:
                if (value != TENSION_OGRE_ABI_VERSION) {
                    char line[112];
                    std::snprintf(line, sizeof(line),
                                  "config refused: `abi_version` is %u, this adapter speaks %u",
                                  value, TENSION_OGRE_ABI_VERSION);
                    return refuse(ConfigError::AbiVersion, key, line);
                }
                config.abi_version = value;
                abi_seen = true;
                break;

            case TENSION_OGRE_KEY_RENDERER:
                if (!in_range(value, TENSION_OGRE_RENDERER_NULL, TENSION_OGRE_RENDERER_VULKAN)) {
                    char line[112];
                    std::snprintf(line, sizeof(line),
                                  "config refused: `renderer` is %u, and 0..%u are the renderer ids",
                                  value, TENSION_OGRE_RENDERER_VULKAN);
                    return refuse(ConfigError::ValueOutOfRange, key, line);
                }
                config.renderer = value;
                break;

            case TENSION_OGRE_KEY_HEADLESS:
            case TENSION_OGRE_KEY_VSYNC: {
                if (value > 1) {
                    char line[112];
                    std::snprintf(line, sizeof(line),
                                  "config refused: `%s` is %u, and it is a flag (0 or 1)",
                                  config_key_name(key), value);
                    return refuse(ConfigError::ValueOutOfRange, key, line);
                }
                if (key == TENSION_OGRE_KEY_HEADLESS)
                    config.headless = (value != 0);
                else
                    config.vsync = (value != 0);
                break;
            }

            case TENSION_OGRE_KEY_FRAME_HZ:
            case TENSION_OGRE_KEY_WINDOW_WIDTH:
            case TENSION_OGRE_KEY_WINDOW_HEIGHT: {
                const uint32_t high =
                    key == TENSION_OGRE_KEY_FRAME_HZ ? kMaxFrameHz : kMaxWindowPixels;
                if (!in_range(value, 1, high)) {
                    char line[128];
                    std::snprintf(line, sizeof(line),
                                  "config refused: `%s` is %u, outside 1..%u",
                                  config_key_name(key), value, high);
                    return refuse(ConfigError::ValueOutOfRange, key, line);
                }
                if (key == TENSION_OGRE_KEY_FRAME_HZ) config.frame_hz = value;
                if (key == TENSION_OGRE_KEY_WINDOW_WIDTH) config.window_width = value;
                if (key == TENSION_OGRE_KEY_WINDOW_HEIGHT) config.window_height = value;
                break;
            }

            default: {
                char line[112];
                std::snprintf(line, sizeof(line),
                              "config refused: key %u is not one this adapter knows", key);
                return refuse(ConfigError::UnknownKey, key, line);
            }
        }
    }

    if (reader.at != reader.len) {
        return refuse(ConfigError::TrailingBytes, 0,
                      "malformed config: trailing bytes after the last entry");
    }
    if (!abi_seen) {
        return refuse(ConfigError::MissingKey, TENSION_OGRE_KEY_ABI_VERSION,
                      "malformed config: `abi_version` is required");
    }

    ConfigDecodeResult result;
    result.ok = true;
    result.config = config;
    result.message = "ok";
    return result;
}

} // namespace tension_ogre
