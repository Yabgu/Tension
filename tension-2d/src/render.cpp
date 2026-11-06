/*
 * render.cpp — the SDL_GPU renderer.
 *
 * The only file in this capability that includes SDL. Everything it needs to
 * know about a sprite arrives as bytes; everything it needs to know about a
 * guest stays on the other side of adapter.cpp.
 *
 * Shape (DESIGN.md §7): one storage buffer holding this frame's records, one
 * upload per frame through a transfer buffer, one graphic pipeline per preset,
 * and **one draw call per bucket** —
 * `SDL_DrawGPUPrimitives(pass, 6, count, 0, first_instance)` — with the vertex
 * shader synthesizing each quad from `gl_InstanceIndex`. No CPU expansion, no
 * vertex buffers.
 *
 * SPDX-License-Identifier: MIT
 */

#include "render.h"

#include "texture.h"
#include "tension_2d.h"

#include <SDL3/SDL.h>

#include <algorithm>
#include <cerrno>
#include <cstring>
#include <map>
#include <vector>

#include "shaders_spv.h"

namespace tension_2d {
namespace {

/// The `sprite` record (DESIGN.md §5, tension_2d.h). Declared here so the
/// adapter can hand over raw bytes and this file can still sort them.
struct Record {
    int32_t x;
    int32_t y;
    uint16_t src_x;
    uint16_t src_y;
    uint16_t w;
    uint16_t h;
    uint16_t tex;
    uint16_t pad;
    uint32_t sort_key;
    uint16_t group_id;
    uint8_t z;
    uint8_t flags;
};
static_assert(sizeof(Record) == TENSION_2D_RECORD_SIZE, "record layout drifted from the header");
static_assert(offsetof(Record, sort_key) == TENSION_2D_OFF_SORT_KEY, "sort_key offset");

constexpr uint32_t kMaxRecords = 4096;
constexpr uint32_t kMaxBuckets = 8;
constexpr uint32_t kMaxTextures = 64;
constexpr uint32_t kMaxPipelines = 16;

struct TextureEntry {
    SDL_GPUTexture *texture = nullptr;
    uint32_t width = 0;
    uint32_t height = 0;
};

std::string sdl_error(const char *what) {
    return std::string(what) + ": " + SDL_GetError();
}

} // namespace

uint32_t record_sort_key(const uint8_t *record) {
    uint32_t key = 0;
    std::memcpy(&key, record + TENSION_2D_OFF_SORT_KEY, sizeof key);
    return key;
}

namespace {

/// Compare two records by the graph's key list.
///
/// The keys are *data* — `kSortKeys` is emitted from the graph's
/// `make_tuple(sort_key, group_id, z)` — so a graph with different keys sorts
/// differently without this function changing. The Rust compiler emits the
/// same comparison with Cranelift
/// (`tension-core/src/pipeline/cranelift_backend.rs`); the two must agree, and
/// the pixel-identity test is what holds them to it.
///
/// Dtypes are the wire codes from `TENSION_DTYPE_*`, plus 6 for u32.
int compare_by_keys(const void *lhs, const void *rhs) {
    const auto *a = static_cast<const uint8_t *>(lhs);
    const auto *b = static_cast<const uint8_t *>(rhs);
    for (unsigned i = 0; i < TENSION_2D_SORT_KEY_COUNT; ++i) {
        const unsigned offset = kSortKeys[i].offset;
        switch (kSortKeys[i].dtype) {
        case 1: { // f32, optionally scaled by a mul key
            float x, y;
            std::memcpy(&x, a + offset, 4);
            std::memcpy(&y, b + offset, 4);
            x *= kSortKeys[i].scale;
            y *= kSortKeys[i].scale;
            if (x < y) return -1;
            if (x > y) return 1;
            break;
        }
        case 2: { // u16
            uint16_t x, y;
            std::memcpy(&x, a + offset, 2);
            std::memcpy(&y, b + offset, 2);
            if (x != y) return x < y ? -1 : 1;
            break;
        }
        case 3: { // i16
            int16_t x, y;
            std::memcpy(&x, a + offset, 2);
            std::memcpy(&y, b + offset, 2);
            if (x != y) return x < y ? -1 : 1;
            break;
        }
        case 4: { // u8
            const uint8_t x = a[offset], y = b[offset];
            if (x != y) return x < y ? -1 : 1;
            break;
        }
        case 5: { // i32
            int32_t x, y;
            std::memcpy(&x, a + offset, 4);
            std::memcpy(&y, b + offset, 4);
            if (x != y) return x < y ? -1 : 1;
            break;
        }
        default: { // u32
            uint32_t x, y;
            std::memcpy(&x, a + offset, 4);
            std::memcpy(&y, b + offset, 4);
            if (x != y) return x < y ? -1 : 1;
            break;
        }
        }
    }
    return 0;
}

} // namespace

struct Renderer::Impl {
    SDL_GPUDevice *device = nullptr;
    SDL_GPUTexture *target = nullptr;
    SDL_GPUSampler *sampler = nullptr;
    SDL_GPUTexture *default_texture = nullptr;
    uint32_t default_texture_width = 1;
    uint32_t default_texture_height = 1;
    SDL_GPUBuffer *storage = nullptr;
    SDL_GPUTransferBuffer *upload = nullptr;
    SDL_GPUTransferBuffer *download = nullptr;
    bool sdl_started = false;

    std::map<uint32_t, SDL_GPUGraphicsPipeline *> pipelines;
    std::map<uint32_t, TextureEntry> textures;
    uint32_t bound_texture = 0;

    struct Bucket {
        uint32_t pipe_id = 0;
        std::vector<Record> records;
    };
    std::map<uint32_t, Bucket> buckets;
    bool presented_once = false;

    // ── helpers ──────────────────────────────────────────────────────────

    SDL_GPUTexture *create_texture(uint32_t width, uint32_t height,
                                   SDL_GPUTextureUsageFlags usage) {
        SDL_GPUTextureCreateInfo info = {};
        info.type = SDL_GPU_TEXTURETYPE_2D;
        info.format = SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM;
        info.usage = usage;
        info.width = width;
        info.height = height;
        info.layer_count_or_depth = 1;
        info.num_levels = 1;
        info.sample_count = SDL_GPU_SAMPLECOUNT_1;
        return SDL_CreateGPUTexture(device, &info);
    }

    /// Upload a tightly packed RGBA8 raster. The transfer buffer is created per
    /// call: textures load rarely, and a shared one would need size tracking
    /// that this path does not earn.
    int32_t upload_rgba(const uint8_t *rgba, uint32_t width, uint32_t height,
                        SDL_GPUTexture **out, std::string &err) {
        const uint32_t bytes = width * height * 4u;
        SDL_GPUTransferBufferCreateInfo tci = {};
        tci.usage = SDL_GPU_TRANSFERBUFFERUSAGE_UPLOAD;
        tci.size = bytes;
        SDL_GPUTransferBuffer *xfer = SDL_CreateGPUTransferBuffer(device, &tci);
        if (xfer == nullptr) {
            err = sdl_error("CreateGPUTransferBuffer(upload)");
            return -EIO;
        }

        SDL_GPUTexture *texture = create_texture(width, height, SDL_GPU_TEXTUREUSAGE_SAMPLER);
        if (texture == nullptr) {
            SDL_ReleaseGPUTransferBuffer(device, xfer);
            err = sdl_error("CreateGPUTexture");
            return -ENOMEM;
        }

        void *mapped = SDL_MapGPUTransferBuffer(device, xfer, false);
        if (mapped == nullptr) {
            SDL_ReleaseGPUTexture(device, texture);
            SDL_ReleaseGPUTransferBuffer(device, xfer);
            err = sdl_error("MapGPUTransferBuffer");
            return -EIO;
        }
        std::memcpy(mapped, rgba, bytes);
        SDL_UnmapGPUTransferBuffer(device, xfer);

        SDL_GPUCommandBuffer *cmd = SDL_AcquireGPUCommandBuffer(device);
        if (cmd == nullptr) {
            SDL_ReleaseGPUTexture(device, texture);
            SDL_ReleaseGPUTransferBuffer(device, xfer);
            err = sdl_error("AcquireGPUCommandBuffer");
            return -EIO;
        }
        SDL_GPUCopyPass *copy = SDL_BeginGPUCopyPass(cmd);
        SDL_GPUTextureTransferInfo src = {};
        src.transfer_buffer = xfer;
        src.pixels_per_row = width;
        src.rows_per_layer = height;
        SDL_GPUTextureRegion dst = {};
        dst.texture = texture;
        dst.w = width;
        dst.h = height;
        dst.d = 1;
        SDL_UploadToGPUTexture(copy, &src, &dst, true);
        SDL_EndGPUCopyPass(copy);
        const bool submitted = SDL_SubmitGPUCommandBuffer(cmd);
        SDL_ReleaseGPUTransferBuffer(device, xfer);
        if (!submitted) {
            SDL_ReleaseGPUTexture(device, texture);
            err = sdl_error("SubmitGPUCommandBuffer(upload)");
            return -EIO;
        }

        *out = texture;
        return 0;
    }

    int32_t build_pipeline(const unsigned char *vs_bytes, size_t vs_size,
                           const unsigned char *fs_bytes, size_t fs_size,
                           uint32_t pipe_id, std::string &err) {
        const uint8_t *vs_code = vs_bytes;
        const size_t vs_len = vs_size;

        SDL_GPUShaderCreateInfo vsi = {};
        vsi.code = vs_code;
        vsi.code_size = vs_len;
        vsi.entrypoint = "main";
        vsi.format = SDL_GPU_SHADERFORMAT_SPIRV;
        vsi.stage = SDL_GPU_SHADERSTAGE_VERTEX;
        vsi.num_storage_buffers = 1;  // set 0, binding 0: the record array
        vsi.num_uniform_buffers = 1;  // set 1, binding 0: the canvas
        SDL_GPUShader *vs = SDL_CreateGPUShader(device, &vsi);
        if (vs == nullptr) {
            err = sdl_error("CreateGPUShader(vertex)");
            return -EIO;
        }

        SDL_GPUShaderCreateInfo fsi = {};
        fsi.code = fs_bytes;
        fsi.code_size = fs_size;
        fsi.entrypoint = "main";
        fsi.format = SDL_GPU_SHADERFORMAT_SPIRV;
        fsi.stage = SDL_GPU_SHADERSTAGE_FRAGMENT;
        fsi.num_samplers = 1;  // set 2, binding 0
        SDL_GPUShader *fs = SDL_CreateGPUShader(device, &fsi);
        if (fs == nullptr) {
            SDL_ReleaseGPUShader(device, vs);
            err = sdl_error("CreateGPUShader(fragment)");
            return -EIO;
        }

        SDL_GPUColorTargetDescription ctd = {};
        ctd.format = SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM;

        SDL_GPUGraphicsPipelineCreateInfo pci = {};
        pci.vertex_shader = vs;
        pci.fragment_shader = fs;
        // No vertex buffers: every field comes from the storage buffer.
        pci.vertex_input_state.num_vertex_buffers = 0;
        pci.vertex_input_state.num_vertex_attributes = 0;
        pci.primitive_type = SDL_GPU_PRIMITIVETYPE_TRIANGLELIST;
        pci.rasterizer_state.fill_mode = SDL_GPU_FILLMODE_FILL;
        pci.rasterizer_state.cull_mode = SDL_GPU_CULLMODE_NONE;
        pci.multisample_state.sample_count = SDL_GPU_SAMPLECOUNT_1;
        pci.target_info.color_target_descriptions = &ctd;
        pci.target_info.num_color_targets = 1;

        SDL_GPUGraphicsPipeline *pipeline = SDL_CreateGPUGraphicsPipeline(device, &pci);
        SDL_ReleaseGPUShader(device, vs);
        SDL_ReleaseGPUShader(device, fs);
        if (pipeline == nullptr) {
            err = sdl_error("CreateGPUGraphicsPipeline");
            return -EIO;
        }
        pipelines[pipe_id] = pipeline;
        return 0;
    }

    void release_all() {
        for (auto &entry : pipelines) SDL_ReleaseGPUGraphicsPipeline(device, entry.second);
        pipelines.clear();
        for (auto &entry : textures) SDL_ReleaseGPUTexture(device, entry.second.texture);
        textures.clear();
        if (default_texture != nullptr) SDL_ReleaseGPUTexture(device, default_texture);
        default_texture = nullptr;
        if (sampler != nullptr) SDL_ReleaseGPUSampler(device, sampler);
        sampler = nullptr;
        if (storage != nullptr) SDL_ReleaseGPUBuffer(device, storage);
        storage = nullptr;
        if (upload != nullptr) SDL_ReleaseGPUTransferBuffer(device, upload);
        upload = nullptr;
        if (download != nullptr) SDL_ReleaseGPUTransferBuffer(device, download);
        download = nullptr;
        if (target != nullptr) SDL_ReleaseGPUTexture(device, target);
        target = nullptr;
        if (device != nullptr) SDL_DestroyGPUDevice(device);
        device = nullptr;
        if (sdl_started) {
            SDL_Quit();
            sdl_started = false;
        }
        buckets.clear();
        bound_texture = 0;
        presented_once = false;
    }
};

Renderer::Renderer() : impl_(new Impl()) {}
Renderer::~Renderer() { close(); }

bool Renderer::is_open() const { return impl_ != nullptr && impl_->device != nullptr; }

uint32_t Renderer::width() const { return kCanvasWidth; }
uint32_t Renderer::height() const { return kCanvasHeight; }
uint32_t Renderer::max_records() { return kMaxRecords; }
uint32_t Renderer::max_buckets() { return kMaxBuckets; }
uint32_t Renderer::pipeline_count() const {
    return impl_ ? static_cast<uint32_t>(impl_->pipelines.size()) : 0u;
}
uint32_t Renderer::texture_count() const {
    return impl_ ? static_cast<uint32_t>(impl_->textures.size()) : 0u;
}

int32_t Renderer::open(std::string &err) {
    if (is_open()) return -EBUSY;

    // SDL's video subsystem is refcounted process-wide; tension-input does the
    // same from its own thread. Both quit what they started.
    if (!SDL_Init(SDL_INIT_VIDEO)) {
        err = sdl_error("SDL_Init");
        return -ENODEV;
    }
    impl_->sdl_started = true;

    impl_->device = SDL_CreateGPUDevice(SDL_GPU_SHADERFORMAT_SPIRV, false, nullptr);
    if (impl_->device == nullptr) {
        // Distinguish "this build has no GPU backend" from "this machine has no
        // device" no further than SDL lets us: the message is what a reader gets.
        err = sdl_error("CreateGPUDevice");
        impl_->release_all();
        return -ENODEV;
    }

    impl_->target = impl_->create_texture(kCanvasWidth, kCanvasHeight,
                                          SDL_GPU_TEXTUREUSAGE_COLOR_TARGET);
    if (impl_->target == nullptr) {
        err = sdl_error("CreateGPUTexture(target)");
        impl_->release_all();
        return -ENOMEM;
    }

    SDL_GPUSamplerCreateInfo sci = {};
    sci.min_filter = SDL_GPU_FILTER_NEAREST;
    sci.mag_filter = SDL_GPU_FILTER_NEAREST;
    sci.mipmap_mode = SDL_GPU_SAMPLERMIPMAPMODE_NEAREST;
    sci.address_mode_u = SDL_GPU_SAMPLERADDRESSMODE_CLAMP_TO_EDGE;
    sci.address_mode_v = SDL_GPUSamplerAddressMode(2);
    sci.address_mode_w = SDL_GPUSamplerAddressMode(2);
    impl_->sampler = SDL_CreateGPUSampler(impl_->device, &sci);
    if (impl_->sampler == nullptr) {
        err = sdl_error("CreateGPUSampler");
        impl_->release_all();
        return -EIO;
    }

    // The texture a bucket binds when it has none: 1x1 opaque white, so a
    // record that names no atlas still draws its rect.
    const uint8_t white[4] = {255, 255, 255, 255};
    if (const int32_t rc = impl_->upload_rgba(white, 1, 1, &impl_->default_texture, err); rc != 0) {
        impl_->release_all();
        return rc;
    }

    SDL_GPUBufferCreateInfo bci = {};
    bci.usage = SDL_GPU_BUFFERUSAGE_GRAPHICS_STORAGE_READ;
    bci.size = kMaxRecords * TENSION_2D_RECORD_SIZE;
    impl_->storage = SDL_CreateGPUBuffer(impl_->device, &bci);
    if (impl_->storage == nullptr) {
        err = sdl_error("CreateGPUBuffer(storage)");
        impl_->release_all();
        return -ENOMEM;
    }

    SDL_GPUTransferBufferCreateInfo uci = {};
    uci.usage = SDL_GPU_TRANSFERBUFFERUSAGE_UPLOAD;
    uci.size = kMaxRecords * TENSION_2D_RECORD_SIZE;
    impl_->upload = SDL_CreateGPUTransferBuffer(impl_->device, &uci);
    if (impl_->upload == nullptr) {
        err = sdl_error("CreateGPUTransferBuffer(storage)");
        impl_->release_all();
        return -ENOMEM;
    }

    return 0;
}

void Renderer::close() {
    if (impl_ == nullptr || impl_->device == nullptr) return;
    impl_->release_all();
}

int32_t Renderer::set_pipeline(uint16_t preset_id, uint32_t &pipe_id, std::string &err) {
    if (!is_open()) return -ENODEV;
    if (preset_id < TENSION_2D_PIPE_PRESET_MIN || preset_id > TENSION_2D_PIPE_PRESET_MAX) {
        err = "set_pipeline: preset id outside 1..99";
        return -ENOENT;
    }
    if (preset_id != 1) {
        // Only preset 1 ("default_2d") has a compiled stage in this build.
        err = "set_pipeline: preset '" + std::to_string(preset_id) + "' is not built into this adapter";
        return -ENOSYS;
    }
    if (impl_->pipelines.find(preset_id) == impl_->pipelines.end()) {
        if (impl_->pipelines.size() >= kMaxPipelines) {
            err = "set_pipeline: pipeline table full";
            return -ENOSPC;
        }
        if (const int32_t rc = impl_->build_pipeline(kSpriteVertSpv, kSpriteVertSpvLen,
                                                     kSpriteFragSpv, kSpriteFragSpvLen, preset_id,
                                                     err);
            rc != 0) {
            return rc;
        }
    }
    pipe_id = preset_id;
    return 0;
}

int32_t Renderer::submit(uint32_t pipe_id, const uint8_t *records, uint32_t count,
                         uint32_t stride, uint32_t bucket, uint32_t &accepted,
                         std::string &err) {
    if (!is_open()) return -ENODEV;
    if (impl_->pipelines.find(pipe_id) == impl_->pipelines.end()) {
        err = "submit: unknown pipe_id " + std::to_string(pipe_id);
        return -ENOENT;
    }
    if (records == nullptr || count == 0) {
        err = "submit: empty submission";
        return -EINVAL;
    }
    if (stride != TENSION_2D_RECORD_SIZE) {
        err = "submit: record_stride disagrees with the layout";
        return -EINVAL;
    }
    if (bucket >= kMaxBuckets) {
        err = "submit: bucket index outside 0..7";
        return -EINVAL;
    }

    uint32_t staged = 0;
    for (const auto &entry : impl_->buckets) staged += static_cast<uint32_t>(entry.second.records.size());
    if (staged + count > kMaxRecords) {
        err = "submit: staging buffer full (" + std::to_string(kMaxRecords) + " records)";
        return -ENOSPC;
    }

    if (impl_->buckets.count(bucket) != 0 && impl_->buckets[bucket].pipe_id != pipe_id) {
        // A bucket is one draw call, so it is one pipeline. Two pipes in one
        // bucket is not a merge this adapter will guess at.
        err = "submit: bucket " + std::to_string(bucket) + " already belongs to pipe " +
              std::to_string(impl_->buckets[bucket].pipe_id);
        return -EINVAL;
    }
    Impl::Bucket &slot = impl_->buckets[bucket];
    slot.pipe_id = pipe_id;
    std::vector<Record> &target = slot.records;
    target.reserve(target.size() + count);
    for (uint32_t i = 0; i < count; ++i) {
        Record record;
        std::memcpy(&record, records + static_cast<size_t>(i) * stride, sizeof record);
        target.push_back(record);
    }
    accepted = count;
    return 0;
}

namespace {
/// FNV-1a 64, matching `pipeline::Graph::hash` in Rust and the build script's
/// `fnv1a`. Three implementations of one hash is two too many; the build fails
/// if they disagree, because `build-2d.mjs` prints the value both write.
uint64_t fnv1a64(const uint8_t *bytes, size_t len) {
    uint64_t hash = 0xcbf29ce484222325ull;
    for (size_t i = 0; i < len; ++i) {
        hash ^= static_cast<uint64_t>(bytes[i]);
        hash *= 0x100000001b3ull;
    }
    return hash;
}
} // namespace

int32_t Renderer::set_pipeline_blob(const uint8_t *blob, size_t len, uint32_t &pipe_id,
                                    std::string &err) {
    if (!is_open()) return -ENODEV;
    if (blob == nullptr || len == 0) {
        err = "set_pipeline: empty blob";
        return -EINVAL;
    }
    // The blob is identified by its hash. A graph whose compiled artifacts were
    // not embedded at build time is -ENOSYS: this DSO has no runtime compiler,
    // and pretending otherwise would mean linking a Rust toolchain into a
    // capability.
    // The blob is identified by its hash, and this DSO carries the artifacts
    // for exactly the graphs it was built with. A blob this build was not built
    // with is -ENOSYS: there is no runtime compiler (DESIGN.md §14).
    const uint64_t hash = fnv1a64(blob, len);
    const struct Tension2dGraphPipe *entry = nullptr;
    for (const auto &candidate : kGraphPipes) {
        if (candidate.hash == hash) {
            entry = &candidate;
            break;
        }
    }
    if (entry == nullptr) {
        err = "set_pipeline: this build has no compiled artifacts for that graph";
        return -ENOSYS;
    }
    if (impl_->pipelines.find(entry->pipe_id) == impl_->pipelines.end()) {
        if (impl_->pipelines.size() >= kMaxPipelines) {
            err = "set_pipeline: pipeline table full";
            return -ENOSPC;
        }
        if (const int32_t rc = impl_->build_pipeline(entry->vs, entry->vs_len, entry->fs,
                                                     entry->fs_len, entry->pipe_id, err);
            rc != 0) {
            return rc;
        }
    }
    pipe_id = entry->pipe_id;
    return 0;
}

int32_t Renderer::present(std::string &err) {
    if (!is_open()) return -ENODEV;

    // Gather every bucket in ascending order, so the buckets are contiguous in
    // one storage-buffer upload and differ only by first_instance. Sorting
    // within a bucket is stable on `(sort_key, group_id, z)`: equal keys keep
    // which is what makes a frame's draw order reproducible.
    std::vector<Record> frame;
    struct Span {
        uint32_t first;
        uint32_t count;
        uint32_t pipe_id;
    };
    std::vector<Span> spans;
    for (auto &entry : impl_->buckets) {
        // Ordered by the graph's key list (kSortKeys), so the built-in preset
        // and a compiled graph sort identically. Stable, because equal keys
        // must keep submission order: that is what makes a frame reproducible.
        std::stable_sort(entry.second.records.begin(), entry.second.records.end(), [](const Record &a, const Record &b) {
            return compare_by_keys(&a, &b) < 0;
        });
        spans.push_back(Span{static_cast<uint32_t>(frame.size()),
                             static_cast<uint32_t>(entry.second.records.size()),
                             entry.second.pipe_id});
        frame.insert(frame.end(), entry.second.records.begin(), entry.second.records.end());
    }

    SDL_GPUCommandBuffer *cmd = SDL_AcquireGPUCommandBuffer(impl_->device);
    if (cmd == nullptr) {
        err = sdl_error("AcquireGPUCommandBuffer");
        return -EIO;
    }

    if (!frame.empty()) {
        const uint32_t bytes = static_cast<uint32_t>(frame.size()) * TENSION_2D_RECORD_SIZE;
        void *mapped = SDL_MapGPUTransferBuffer(impl_->device, impl_->upload, true);
        if (mapped == nullptr) {
            err = sdl_error("MapGPUTransferBuffer");
            return -EIO;
        }
        std::memcpy(mapped, frame.data(), bytes);
        SDL_UnmapGPUTransferBuffer(impl_->device, impl_->upload);

        SDL_GPUCopyPass *copy = SDL_BeginGPUCopyPass(cmd);
        SDL_GPUTransferBufferLocation src = {};
        src.transfer_buffer = impl_->upload;
        SDL_GPUBufferRegion dst = {};
        dst.buffer = impl_->storage;
        dst.size = bytes;
        SDL_UploadToGPUBuffer(copy, &src, &dst, true);
        SDL_EndGPUCopyPass(copy);
    }

    SDL_GPUColorTargetInfo cti = {};
    cti.texture = impl_->target;
    cti.clear_color = SDL_FColor{0.0f, 0.0f, 0.0f, 1.0f};
    cti.load_op = SDL_GPU_LOADOP_CLEAR;
    cti.store_op = SDL_GPU_STOREOP_STORE;
    SDL_GPURenderPass *pass = SDL_BeginGPURenderPass(cmd, &cti, 1, nullptr);
    if (pass == nullptr) {
        err = sdl_error("BeginGPURenderPass");
        return -EIO;
    }

    if (!frame.empty()) {
        // One pipeline per span: buckets may belong to different pipes, and a
        // pipeline bound for the wrong span draws the wrong shader.
        uint32_t bound_pipe = 0;

        SDL_GPUBuffer *bound[1] = {impl_->storage};
        SDL_BindGPUVertexStorageBuffers(pass, 0, bound, 1);

        // The uniform block is `{ vec2 u_canvas_half; vec2 u_tex_size; }`, so the
        // texture's own dimensions go with it: the shader normalizes the
        // record's pixel src rect by them before sampling.
        SDL_GPUTexture *texture = impl_->default_texture;
        float tex_w = static_cast<float>(impl_->default_texture_width);
        float tex_h = static_cast<float>(impl_->default_texture_height);
        auto found = impl_->textures.find(impl_->bound_texture);
        if (found != impl_->textures.end()) {
            texture = found->second.texture;
            tex_w = static_cast<float>(found->second.width);
            tex_h = static_cast<float>(found->second.height);
        }
        const float uniforms[4] = {kCanvasWidth * 0.5f, kCanvasHeight * 0.5f, tex_w, tex_h};
        SDL_PushGPUVertexUniformData(cmd, 0, uniforms, sizeof uniforms);

        SDL_GPUTextureSamplerBinding tex = {};
        tex.texture = texture;
        tex.sampler = impl_->sampler;
        SDL_BindGPUFragmentSamplers(pass, 0, &tex, 1);

        for (const auto &span : spans) {
            if (span.count == 0) continue;
            if (span.pipe_id != bound_pipe) {
                auto pipeline = impl_->pipelines.find(span.pipe_id);
                if (pipeline == impl_->pipelines.end()) continue;
                SDL_BindGPUGraphicsPipeline(pass, pipeline->second);
                bound_pipe = span.pipe_id;
            }
            SDL_DrawGPUPrimitives(pass, 6, span.count, 0, span.first);
        }
    }

    SDL_EndGPURenderPass(pass);
    if (!SDL_SubmitGPUCommandBuffer(cmd)) {
        err = sdl_error("SubmitGPUCommandBuffer");
        return -EIO;
    }
    if (!SDL_WaitForGPUIdle(impl_->device)) {
        err = sdl_error("WaitForGPUIdle");
        return -EIO;
    }

    impl_->buckets.clear();
    impl_->presented_once = true;
    return 0;
}

int32_t Renderer::texture_load(const uint8_t *src, size_t len, int32_t target_format,
                               uint32_t &texture_id, std::string &err) {
    if (!is_open()) return -ENODEV;
    if (target_format != TENSION_2D_TEX_RGBA8) {
        // The other three formats exist in the wire (tension_2d.h) and need a
        // conversion this build cannot do: it holds decoded RGBA8 only.
        err = "texture_load: only RGBA8 targets are served at v1";
        return -ENOSYS;
    }
    if (impl_->textures.size() >= kMaxTextures) {
        err = "texture_load: texture table full";
        return -ENOSPC;
    }

    DecodedImage image;
    const int32_t rc = decode_iwi(src, len, image, err);
    if (rc != 0) return rc;

    SDL_GPUTexture *texture = nullptr;
    if (const int32_t up = impl_->upload_rgba(image.rgba.data(), image.width, image.height,
                                              &texture, err);
        up != 0) {
        return up;
    }

    const uint32_t id = static_cast<uint32_t>(impl_->textures.size()) + 1u;
    impl_->textures[id] = TextureEntry{texture, image.width, image.height};
    // v1 binds one atlas per frame: multi-atlas needs a texture array or a
    // per-bucket binding pass, and DESIGN.md §5 puts `tex` in the record for
    // exactly that future. The most recently loaded texture is the bound one.
    impl_->bound_texture = id;
    texture_id = id;
    return 0;
}

int32_t Renderer::screenshot(uint8_t *dst, size_t cap, size_t &written, std::string &err) {
    if (!is_open()) return -ENODEV;
    if (!impl_->presented_once) {
        err = "screenshot: nothing has been presented";
        return -ENODEV;
    }

    const size_t bytes = static_cast<size_t>(kCanvasWidth) * kCanvasHeight * 4u;
    if (cap < bytes) {
        err = "screenshot: buffer shorter than " + std::to_string(bytes) + " bytes";
        return -ENOSPC;
    }

    if (impl_->download == nullptr) {
        SDL_GPUTransferBufferCreateInfo dci = {};
        dci.usage = SDL_GPU_TRANSFERBUFFERUSAGE_DOWNLOAD;
        dci.size = static_cast<uint32_t>(bytes);
        impl_->download = SDL_CreateGPUTransferBuffer(impl_->device, &dci);
        if (impl_->download == nullptr) {
            err = sdl_error("CreateGPUTransferBuffer(download)");
            return -ENOMEM;
        }
    }

    SDL_GPUCommandBuffer *cmd = SDL_AcquireGPUCommandBuffer(impl_->device);
    if (cmd == nullptr) {
        err = sdl_error("AcquireGPUCommandBuffer(download)");
        return -EIO;
    }
    SDL_GPUCopyPass *copy = SDL_BeginGPUCopyPass(cmd);
    SDL_GPUTextureRegion region = {};
    region.texture = impl_->target;
    region.w = kCanvasWidth;
    region.h = kCanvasHeight;
    region.d = 1;
    SDL_GPUTextureTransferInfo info = {};
    info.transfer_buffer = impl_->download;
    info.pixels_per_row = kCanvasWidth;
    info.rows_per_layer = kCanvasHeight;
    SDL_DownloadFromGPUTexture(copy, &region, &info);
    SDL_EndGPUCopyPass(copy);
    if (!SDL_SubmitGPUCommandBuffer(cmd)) {
        err = sdl_error("SubmitGPUCommandBuffer(download)");
        return -EIO;
    }
    if (!SDL_WaitForGPUIdle(impl_->device)) {
        err = sdl_error("WaitForGPUIdle(download)");
        return -EIO;
    }

    const void *mapped = SDL_MapGPUTransferBuffer(impl_->device, impl_->download, false);
    if (mapped == nullptr) {
        err = sdl_error("MapGPUTransferBuffer(download)");
        return -EIO;
    }
    std::memcpy(dst, mapped, bytes);
    SDL_UnmapGPUTransferBuffer(impl_->device, impl_->download);

    written = bytes;
    return 0;
}

} // namespace tension_2d
