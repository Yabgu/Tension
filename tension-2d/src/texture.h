/*
 * texture.h — decoding for the 2D adapter, SDL-free.
 *
 * v1 reads **IWI** directly: the container `IWImageIO.ixx` writes, which is
 * what a pack step produces with `iwconv <in.png> <out.iwi>`.
 *
 * The eventual path is ImageViewer's `iw_decode_to_format(src, len, target,
 * space, premultiply)` (`docs/modules/2d.md` §8), which would also give PNG and JPEG and
 * the colour-space and premultiplication policy. That function does not exist
 * in ImageViewer yet, so this file deliberately does the narrow thing: one
 * container, one layout family, and `-ENOSYS` for everything else rather than a
 * guess that renders wrong colours the first time someone loads a JPEG.
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
