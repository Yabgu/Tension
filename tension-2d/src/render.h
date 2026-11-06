/*
 * render.h — the 2D renderer's internal interface.
 *
 * Deliberately SDL-free: adapter.cpp includes this and nothing else, so no SDL
 * type can leak into the ABI edge. Every SDL include lives in render.cpp.
 *
 * The split follows tension-ogre/src/adapter.cpp's: the adapter owns the wire,
 * validation and guest memory; the renderer owns the device and knows nothing
 * about guests.
 *
 * SPDX-License-Identifier: MIT
 */
#ifndef TENSION_2D_RENDER_H
#define TENSION_2D_RENDER_H

#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>

namespace tension_2d {

/// The canvas ceiling, matching `tension_2d.h`'s `open` contract. It is the
/// Vulkan guaranteed minimum `maxImageDimension2D`, so a size accepted here is
/// one every conformant device can allocate.
constexpr uint32_t kMaxCanvasDimension = 16384;

/// The canvas is a runtime decision (`open(width, height, flags)`), not a
/// build-time one: a 2D game knows its resolution and the adapter does not.
/// The target, the clip-space projection and the screenshot readback all take
/// their size from the handle rather than from a constant.

/// The renderer: one SDL_GPU device, one offscreen target, one pipeline table
/// and one texture table.
class Renderer {
public:
    Renderer();
    ~Renderer();

    Renderer(const Renderer &) = delete;
    Renderer &operator=(const Renderer &) = delete;

    /// Create the device, a `width` x `height` offscreen target, the sampler and
    /// the 1x1 default texture. Returns 0 or a negative errno; `err` carries
    /// SDL's message.
    int32_t open(uint32_t width, uint32_t height, std::string &err);
    void close();
    bool is_open() const;

    /// Build (or find) the pipeline for a built-in preset.
    int32_t set_pipeline(uint16_t preset_id, uint32_t &pipe_id, std::string &err);

    /// Resolve a graph blob to a pipeline. At v1 the compiled artifacts are
    /// embedded by `scripts/build-2d.mjs` and identified by the blob's hash; a
    /// blob this build was not built with is `-ENOSYS`.
    int32_t set_pipeline_blob(const uint8_t *blob, size_t len, uint32_t &pipe_id,
                              std::string &err);

    /// Build a pipeline from modules compiled elsewhere (the host's
    /// `compile_graph` slot). `pipe_id` is allocated from 1000 upward, which is
    /// the range `tension_2d.h` reserves for runtime-compiled graphs.
    int32_t set_pipeline_spirv(const uint8_t *vs, size_t vs_len, const uint8_t *fs, size_t fs_len,
                               uint32_t &pipe_id, std::string &err);

    /// Whether a blob's hash is one this build shipped artifacts for.
    bool has_builtin_graph(uint64_t hash) const;

    /// Append records to a bucket. `records` is the adapter's copy — the
    /// renderer never sees a guest pointer.
    int32_t submit(uint32_t pipe_id, const uint8_t *records, uint32_t count,
                   uint32_t stride, uint32_t bucket, uint32_t &accepted,
                   std::string &err);

    /// Draw every bucket recorded since the last call, then clear the staging
    /// state.
    int32_t present(std::string &err);

    /// Decode and upload one texture.
    int32_t texture_load(const uint8_t *src, size_t len, int32_t target_format,
                         uint32_t &texture_id, std::string &err);

    /// Bind a loaded texture to one page of a pipeline's texture array.
    ///
    /// The record's `tex` is the page index, so this is what makes the field
    /// mean something: the shader samples `texture2DArray` at layer `slot`.
    int32_t set_texture(uint32_t pipe_id, uint32_t slot, uint32_t texture_id, std::string &err);

    /// Copy the last presented frame out as RGBA8.
    int32_t screenshot(uint8_t *dst, size_t cap, size_t &written, std::string &err);

    uint32_t width() const;
    uint32_t height() const;
    uint32_t pipeline_count() const;
    uint32_t texture_count() const;
    static uint32_t max_records();
    static uint32_t max_buckets();
    static uint32_t max_atlas_pages();

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

/// Read the `sort_key` out of one record so the adapter can share the layout.
/// Kept here beside the record definition rather than duplicated in the header.
uint32_t record_sort_key(const uint8_t *record);

/// FNV-1a 64 over a blob: the key a compiled pipeline is cached under. Matches
/// `pipeline::Graph::hash` in Rust and the build script's `fnv1a`, so all three
/// agree on a blob's identity.
uint64_t graph_hash(const uint8_t *bytes, size_t len);

} // namespace tension_2d

#endif // TENSION_2D_RENDER_H
