// The ogre config TLV decoder.
//
// The wire is the shared argmap shape (tension-framework/assembly/runtime/tlv.ts
// and the session's own decoder in tension-core/src/session/config.rs):
//
//   u32 entry_count, then per entry
//     u32 key, u8 tag (2 = i64), i64 value (little-endian, upper four bytes zero)
//
// Strict, and stricter than the session's decoder in one place on purpose: a
// key this build does not define is refused here, where the session ignores
// one. The session's argmap is an open namespace the guest grows; this is a
// capability's own ABI-1 surface, and a guest that asks for a key the adapter
// has never heard of is asking for a feature it does not have.
//
// This file includes no OGRE header: the decoder is testable on its own, and
// the adapter's OGRE-facing code lives behind it.

#ifndef TENSION_OGRE_CONFIG_H
#define TENSION_OGRE_CONFIG_H

#include <cstddef>
#include <cstdint>
#include <string>

namespace tension_ogre {

/// Every way a config can be refused, each naming the failed check.
enum class ConfigError {
    None = 0,
    Truncated,          ///< the stream ends inside an entry
    AbiVersionNotFirst, ///< the first entry is not `abi_version`
    AbiVersion,         ///< `abi_version` is not the version this build speaks
    UnknownKey,         ///< a key this build does not define
    MalformedTag,       ///< a value tag that is not 2
    ValueOverflow,      ///< an i64 whose upper four bytes are not zero
    TrailingBytes,      ///< the entries end before the buffer does
    ValueOutOfRange,    ///< a known key carrying an impossible value
    MissingKey,         ///< `abi_version` is absent
};

/// The parsed config, with this build's defaults for every optional key.
struct Config {
    uint32_t abi_version = 0;
    uint32_t renderer = 1;   ///< TENSION_OGRE_RENDERER_GL3PLUS
    bool headless = false;   ///< ask for no window; the NULL render system satisfies it
    bool vsync = false;
    uint32_t frame_hz = 60;
    uint32_t window_width = 1280;
    uint32_t window_height = 720;
};

/// Either a config or the named reason it was refused.
struct ConfigDecodeResult {
    bool ok = false;
    Config config;
    ConfigError error = ConfigError::None;
    /// The key the refusal is about, when it is about one; 0 otherwise.
    uint32_t error_key = 0;
    /// One line naming the refusal, for a `[tension:ogre]` diagnostic.
    std::string message;

    /// The error's name, for tests and logs that want the token.
    const char *error_name() const;
};

/// Decode `len` bytes at `bytes`. Never throws; every refusal is a result.
ConfigDecodeResult decode_config(const uint8_t *bytes, size_t len);

/// The name of an error token, e.g. `"unknown-key"`.
const char *config_error_name(ConfigError error);

/// A key's name, e.g. `"renderer"`, or `"<unknown>"`.
const char *config_key_name(uint32_t key);

} // namespace tension_ogre

#endif // TENSION_OGRE_CONFIG_H
