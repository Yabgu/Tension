/*
 * texture.h — decoding for the 2D adapter, SDL-free.
 *
 * The container is **IWI**, and its grammar is ImageViewer's: this adapter
 * calls `IwiFile.h` (`third_party/ImageViewer/src/format/`) rather than
 * carrying a parser. The reference DSO links `IwiFile.cpp` directly, so the
 * bisect path and the in-core renderer accept exactly the same files.
 *
 * What remains here is policy: interleaved 8-bit RGB/RGBA, raw payload, no
 * stride, semantics R/G/B[/A] in order. Anything else is `-ENOSYS` rather than
 * a guess that renders wrong colours the first time someone loads a planar or
 * 16-bit file.
 *
 * SPDX-License-Identifier: MIT
 */
#ifndef TENSION_2D_TEXTURE_H
#define TENSION_2D_TEXTURE_H

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace tension_2d {

/// A decoded raster, always RGBA8 and always tightly packed.
struct DecodedImage {
    uint32_t width = 0;
    uint32_t height = 0;
    std::vector<uint8_t> rgba;
};

/// Decode `len` bytes at `src` into `out`.
///
/// Returns 0 on success, -EINVAL for a malformed container, -ENOSYS for a
/// source layout this build does not serve.
int32_t decode_iwi(const uint8_t *src, size_t len, DecodedImage &out, std::string &err);

} // namespace tension_2d

#endif // TENSION_2D_TEXTURE_H
