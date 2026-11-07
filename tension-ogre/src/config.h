// The ogre config TLV decoder.
//
// The wire is the shared argmap shape (tension-framework/assembly/runtime/tlv.ts
// and the session's own decoder in tension-core/src/session/config.rs):
//
//   u32 entry_count, then per entry
//     u32 key, u8 tag (2 = i64), i64 value (little-endian, upper four bytes zero)
//
// Strict about the wire, permissive about the key space — the same policy as
// the session's decoder (tension-core/src/session/config.rs): a key this build
// does not define is *ignored*, not refused, because both decoders read the
// same argmap and the argmap is a namespace a newer SDK may grow. The entry is
// still structurally validated (tag, width, and the entry count), so an
// unknown key cannot desynchronise the stream; a *missing* required key is
// still a refusal, because that is a config the adapter cannot run.
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
    /// The host's Vulkan instance and surface (ABI v6), or 0 for "the host owns
    /// none" — in which case the backend behaves exactly as it did before v6 and
    /// creates its own window. Not a config key: the guest cannot supply these,
    /// they arrive from the host's table, and they are set after decoding.
    uint64_t external_instance = 0;
    uint64_t external_surface = 0;
    /// Reads the host's *current* surface size, called once per frame by the
    /// render thread. A function pointer rather than a value because the size
    /// changes; a pointer rather than a `std::function` because `Config` is
    /// copied into the backend and this must not allocate on the render thread.
    ///
    /// Null when there is no host surface, which is what makes the per-frame
    /// check cost nothing on the pre-v6 path.
    void (*host_size)(void *ctx, uint32_t *out_w, uint32_t *out_h) = nullptr;
    void *host_size_ctx = nullptr;
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
