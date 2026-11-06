/*
 * texture.cpp — the IWI reader.
 *
 * The format is `IWImageIO.ixx`'s (`src/format/IWImageIO.ixx` in ImageViewer),
 * recorded here as bytes rather than depended on as a C++ module:
 *
 *   offset  size  field
 *        0     4  magic "IWI1"
 *        4     4  width           u32
 *        8     4  height          u32
 *       12     1  colorSpace      u8   (ImageColorSpace)
 *       13     2  componentCount  u16
 *       15     2  bitsPerPixel    u16
 *       17     1  storageLayout   u8   (0 interleaved, 1 planar)
 *       18    48  components[8]   6 bytes each:
 *                                    semantic       u8
 *                                    componentClass u8
 *                                    bitOffset      u16
 *                                    bitWidth       u16
 *       66     8  pixelDataSize   u64
 *       74     *  pixelData       u8[]
 *
 * All little-endian. The C++ module would be a nicer dependency than a hand
 * parse, but modules are not linkable from this DSO without vendoring
 * ImageViewer, and vendoring is gated on `iw_decode_to_format` (DESIGN.md §8).
 * When that lands this file becomes a thin caller and the parse goes away.
 *
 * SPDX-License-Identifier: MIT
 */

#include "texture.h"

#include "tension_2d.h"

#include <cerrno>
#include <cstring>

namespace tension_2d {
namespace {

constexpr size_t kHeaderBytes = 74;
constexpr int kMaxComponents = 8;

uint16_t rd16(const uint8_t *p) { return static_cast<uint16_t>(p[0] | (p[1] << 8)); }

uint32_t rd32(const uint8_t *p) {
    return static_cast<uint32_t>(p[0]) | (static_cast<uint32_t>(p[1]) << 8) |
           (static_cast<uint32_t>(p[2]) << 16) | (static_cast<uint32_t>(p[3]) << 24);
}

uint64_t rd64(const uint8_t *p) {
    uint64_t v = 0;
    for (int i = 0; i < 8; ++i) v |= static_cast<uint64_t>(p[i]) << (8 * i);
    return v;
}

} // namespace

int32_t decode_iwi(const uint8_t *src, size_t len, DecodedImage &out, std::string &err) {
    if (src == nullptr || len < kHeaderBytes) {
        err = "iwi: shorter than the 74-byte header";
        return -EINVAL;
    }
    if (std::memcmp(src, "IWI1", 4) != 0) {
        // Not an IWI at all. Worth distinguishing from a corrupt one: a caller
        // that handed us a PNG is asking for a decoder this build lacks.
        err = "not an IWI container (magic mismatch)";
        return -ENOSYS;
    }

    const uint32_t width = rd32(src + 4);
    const uint32_t height = rd32(src + 8);
    const uint16_t components = rd16(src + 13);
    const uint16_t bits_per_pixel = rd16(src + 15);
    const uint8_t storage = src[17];
    const uint64_t pixel_bytes = rd64(src + 66);

    if (width == 0 || height == 0) {
        err = "iwi: zero width or height";
        return -EINVAL;
    }
    if (storage != 0) {
        err = "iwi: planar storage is not supported at v1";
        return -ENOSYS;
    }
    if (components < 3 || components > 4) {
        err = "iwi: only 3- and 4-component colour is supported at v1";
        return -ENOSYS;
    }
    if (bits_per_pixel != components * 8) {
        err = "iwi: only 8-bit components are supported at v1";
        return -ENOSYS;
    }
    // Every component must be an 8-bit UNORM-ish sample sitting where the
    // interleaved layout says it is. A mismatch here is the difference between
    // a correct image and a misread red channel, so refuse rather than guess.
    for (int i = 0; i < components; ++i) {
        const uint8_t *c = src + 18 + i * 6;
        const uint16_t bit_width = rd16(c + 4);
        const uint16_t bit_offset = rd16(c + 2);
        if (bit_width != 8 || bit_offset != static_cast<uint16_t>(i * 8)) {
            err = "iwi: unexpected component layout";
            return -ENOSYS;
        }
    }

    const uint64_t expected = static_cast<uint64_t>(width) * height * components;
    if (pixel_bytes < expected) {
        err = "iwi: pixel data truncated";
        return -EINVAL;
    }
    if (len < kHeaderBytes + static_cast<size_t>(pixel_bytes)) {
        err = "iwi: file shorter than its declared pixel data";
        return -EINVAL;
    }

    out.width = width;
    out.height = height;
    out.rgba.resize(static_cast<size_t>(width) * height * 4u);

    const uint8_t *px = src + kHeaderBytes;
    const size_t pixels = static_cast<size_t>(width) * height;
    if (components == 4) {
        std::memcpy(out.rgba.data(), px, pixels * 4u);
    } else {
        for (size_t i = 0; i < pixels; ++i) {
            out.rgba[i * 4 + 0] = px[i * 3 + 0];
            out.rgba[i * 4 + 1] = px[i * 3 + 1];
            out.rgba[i * 4 + 2] = px[i * 3 + 2];
            out.rgba[i * 4 + 3] = 255;
        }
    }
    return 0;
}

} // namespace tension_2d
