/*
 * texture.cpp — the IWI reader.
 *
 * The container grammar is ImageViewer's, and this file no longer restates it.
 * `IwiFile.h` is the C ABI over `src/format/IwiFile.cpp`; its header documents
 * the on-disk layout and is the one place that layout is written down. This
 * translation unit is the *policy* layer — what this renderer can display —
 * which is deliberately separate from the grammar:
 *
 *   iwi_parse_structural   a well-formed IWI whose payload is present?
 *   ApplyPolicy            does this build serve the layout? (3- or 4-component,
 *                          8-bit, integer, interleaved, tightly packed, raw,
 *                          R/G/B/A in order — the same policy ImageViewer's
 *                          `IwiFormat.ixx` applies before it displays a file)
 *   iwi_decode             payload -> tightly packed RGBA8
 *
 * **PNG and JPEG are -ENOSYS, not a pending fix.** The build pipeline converts
 * every shipped texture to IWI, so no runtime decoder is on the critical path.
 * Reaching one would take either:
 *
 *   * extending `iwconv` — build-time conversion of more formats. That covers
 *     shipped assets and nothing that arrives at run time (a mod, an editor
 *     preview); or
 *   * a new capability DSO linking a C library over ImageViewer's plugin
 *     decoders (a `libiwimage`). It is designed; it is not built.
 *
 * The DSO links `IwiFile.cpp` directly (`scripts/build-2d.mjs`), so the bisect
 * path and the in-core renderer parse with the same code.
 *
 * SPDX-License-Identifier: MIT
 */

#include "texture.h"

#include "tension_2d.h"

#include "IwiFile.h"

#include <cerrno>
#include <cstring>
#include <limits>
#include <vector>

namespace tension_2d {
namespace {

/*
 * This build's capability policy, applied to a header the grammar accepted.
 *
 * Storage layout is a bitmask, so this is a mask test plus an exact test: a
 * file with FLIP_X set is interleaved by the loose definition and still a
 * layout nobody here renders. A declared stride changes the payload arithmetic,
 * so it is refused rather than silently treated as absent.
 */
int ApplyPolicy(const IwiFileHeader *f) {
    if (f == nullptr) {
        return IWI_STATUS_NO_INPUT;
    }
    if (f->storageLayout.flags != 0u || f->storageLayout.stride != 0u) {
        return IWI_STATUS_UNSUPPORTED_STORAGE;
    }
    if (!iwi_payload_encoding_is_raw(f)) {
        return IWI_STATUS_UNSUPPORTED_ENCODING;
    }

    const uint16_t n = f->componentCount;
    const IwiFileComponent *comps = iwi_file_components(f);

    for (uint16_t i = 0; i < n; ++i) {
        if (comps[i].bitWidth != 8u) {
            return IWI_STATUS_UNSUPPORTED_BIT_DEPTH;
        }
    }
    for (uint16_t i = 0; i < n; ++i) {
        if (comps[i].componentClass != IW_COMPONENT_CLASS_UINT &&
            comps[i].componentClass != IW_COMPONENT_CLASS_UNORM) {
            return IWI_STATUS_UNSUPPORTED_COMPONENT_CLASS;
        }
    }
    if (n != 3u && n != 4u) {
        return IWI_STATUS_UNSUPPORTED_COMPONENT_COUNT;
    }

    static const uint8_t kRequiredSemantics[4] = {
        IW_COMPONENT_SEMANTIC_R, IW_COMPONENT_SEMANTIC_G,
        IW_COMPONENT_SEMANTIC_B, IW_COMPONENT_SEMANTIC_A,
    };
    for (uint16_t i = 0; i < n; ++i) {
        if (comps[i].semantic != kRequiredSemantics[i]) {
            return IWI_STATUS_UNEXPECTED_SEMANTIC;
        }
        if (comps[i].bitOffset != static_cast<uint16_t>(i * 8u)) {
            return IWI_STATUS_COMPONENT_LAYOUT;
        }
    }
    return IWI_STATUS_OK;
}

/// The errno this renderer answers with for a status: a non-IWI (magic
/// mismatch) and a valid-but-unserved layout are both "no decoder here",
/// everything else is "broken container".
int32_t ErrnoFor(int status) {
    if (status == IWI_STATUS_BAD_MAGIC || iwi_status_is_unsupported(status) != 0) {
        return -ENOSYS;
    }
    return -EINVAL;
}

} // namespace

int32_t decode_iwi(const uint8_t *src, size_t len, DecodedImage &out, std::string &err) {
    if (src == nullptr || len < IWI_FILE_BASE_HEADER_BYTES) {
        err = iwi_status_message(IWI_STATUS_TRUNCATED_HEADER);
        return -EINVAL;
    }

    // Size the blob the C API fills: 36 + 6N. `required == 0` means the base
    // header is not readable (or declares no components); hand the parser a
    // base-sized buffer so it returns the precise status rather than this side
    // guessing.
    const size_t required = iwi_file_required_size(src, len);
    std::vector<uint8_t> blob(
        required == 0 ? IWI_FILE_BASE_HEADER_BYTES : required, 0);

    IwiFileHeader *parsed = reinterpret_cast<IwiFileHeader *>(blob.data());
    int rc = iwi_parse_structural(parsed, blob.size(), src, len);
    if (rc == IWI_STATUS_OK) {
        rc = ApplyPolicy(parsed);
    }
    if (rc != IWI_STATUS_OK) {
        err = iwi_status_message(rc);
        return ErrnoFor(rc);
    }

    const IwiFileHeader *f = reinterpret_cast<const IwiFileHeader *>(blob.data());
    const uint64_t pixels = static_cast<uint64_t>(f->width) * f->height;
    if (pixels > static_cast<uint64_t>(std::numeric_limits<size_t>::max() / 4u)) {
        err = iwi_status_message(IWI_STATUS_GEOMETRY_TOO_LARGE);
        return -EINVAL;
    }

    out.width = f->width;
    out.height = f->height;
    out.rgba.resize(static_cast<size_t>(pixels) * 4u);

    rc = iwi_decode(f, src, len, out.rgba.data(), out.rgba.size());
    if (rc != IWI_STATUS_OK) {
        err = iwi_status_message(rc);
        return -EINVAL;
    }
    return 0;
}

} // namespace tension_2d
