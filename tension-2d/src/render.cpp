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

/// One pipeline's texture array.
///
/// `tex` in the record is a page index, and the fragment stage samples
/// `texture2DArray` at that layer. One array per pipeline, not one texture per
/// draw: splitting a bucket by page would reorder the draws and overrule the
/// graph's sort, which is the one thing multi-atlas must not do.
///
/// All pages share the array's dimensions, because an array texture has one
/// size. A page of a different size is refused at `set_texture` rather than
/// resampled — resampling would move pixels inside a cell, and the record's src
/// rect is in pixels.
struct Atlas {
    SDL_GPUTexture *array = nullptr;
    uint32_t width = 0;
    uint32_t height = 0;
    /// Pages bound so far. `0` means the pipeline has no explicit atlas and the
    /// implicit one is used.
    uint32_t pages = 0;
    uint32_t bound[TENSION_2D_MAX_ATLAS_PAGES] = {};
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
    /// The canvas this handle was opened with. Everything that used to read a
    /// compile-time constant reads these instead: the target allocation, the
    /// clip-space projection pushed per draw, and the screenshot readback.
    uint32_t canvas_width = 0;
    uint32_t canvas_height = 0;
    SDL_GPUSampler *sampler = nullptr;
    /// The array a pipeline samples when it has bound nothing: sixteen 1x1
    /// white pages, so a record that names no atlas still draws its rect.
    SDL_GPUTexture *default_array = nullptr;
    /// The array built from the most recently loaded texture, for the pipelines
    /// that never call `set_texture` (every v1 caller). Rebuilt when a new
    /// texture is loaded, so `tex = 0` means "the atlas I just loaded".
    SDL_GPUTexture *implicit_array = nullptr;
    uint32_t implicit_source = 0;
    uint32_t implicit_width = 1;
    uint32_t implicit_height = 1;
    /// The window, when `open` was asked for one. `target` is still the render
    /// target: the window is a *presentation* path, not a second renderer, so a
    /// frame is identical whether it is blitted to a swapchain or read back by
    /// `screenshot`.
    SDL_Window *window = nullptr;
    bool window_claimed = false;
    /// Set when the user closed the window. `present` reports it once and then
    /// stops drawing to a surface that no longer exists.
    bool window_closed = false;
    bool window_close_reported = false;
    SDL_GPUBuffer *storage = nullptr;
    SDL_GPUTransferBuffer *upload = nullptr;
    SDL_GPUTransferBuffer *download = nullptr;
    bool sdl_started = false;

    std::map<uint32_t, SDL_GPUGraphicsPipeline *> pipelines;
    std::map<uint32_t, TextureEntry> textures;
    std::map<uint32_t, Atlas> atlases;
    uint32_t bound_texture = 0;

    struct Bucket {
        uint32_t pipe_id = 0;
        std::vector<Record> records;
    };
    std::map<uint32_t, Bucket> buckets;
    uint32_t next_runtime_pipe = TENSION_2D_PIPE_RAW_MIN;
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

    /// A texture array of `TENSION_2D_MAX_ATLAS_PAGES` layers at one size.
    /// Every page is the same dimensions because an array texture has one size;
    /// `set_texture` refuses a page that disagrees instead of resampling it.
    SDL_GPUTexture *create_array(uint32_t width, uint32_t height) {
        SDL_GPUTextureCreateInfo info = {};
        info.type = SDL_GPU_TEXTURETYPE_2D_ARRAY;
        info.format = SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM;
        info.usage = SDL_GPU_TEXTUREUSAGE_SAMPLER;
        info.width = width;
        info.height = height;
        info.layer_count_or_depth = TENSION_2D_MAX_ATLAS_PAGES;
        info.num_levels = 1;
        info.sample_count = SDL_GPU_SAMPLECOUNT_1;
        return SDL_CreateGPUTexture(device, &info);
    }

    /// Copy one 2D texture into one layer of an array. A GPU-side copy: the
    /// pixels are never read back to the CPU, which is why `TextureEntry` does
    /// not retain them.
    int32_t copy_into_layer(SDL_GPUTexture *src, SDL_GPUTexture *dst, uint32_t layer,
                            uint32_t width, uint32_t height, std::string &err) {
        SDL_GPUCommandBuffer *cmd = SDL_AcquireGPUCommandBuffer(device);
        if (cmd == nullptr) {
            err = sdl_error("AcquireGPUCommandBuffer(copy)");
            return -EIO;
        }
        SDL_GPUCopyPass *copy = SDL_BeginGPUCopyPass(cmd);
        SDL_GPUTextureLocation source = {};
        source.texture = src;
        SDL_GPUTextureLocation dest = {};
        dest.texture = dst;
        dest.layer = layer;
        SDL_CopyGPUTextureToTexture(copy, &source, &dest, width, height, 1, false);
        SDL_EndGPUCopyPass(copy);
        if (!SDL_SubmitGPUCommandBuffer(cmd)) {
            err = sdl_error("SubmitGPUCommandBuffer(copy)");
            return -EIO;
        }
        return 0;
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
        fsi.num_samplers = 2;  // set 2: the sampled texture AND its sampler
        SDL_GPUShader *fs = SDL_CreateGPUShader(device, &fsi);
        if (fs == nullptr) {
            SDL_ReleaseGPUShader(device, vs);
            err = sdl_error("CreateGPUShader(fragment)");
            return -EIO;
        }

        SDL_GPUColorTargetDescription ctd = {};
        ctd.format = SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM;
        // Straight alpha, source-over. Without this every transparent texel
        // writes something — the default is `enable_blend = false`, so a sprite
        // cut-out draws as an opaque black rectangle the size of its src rect.
        // The first version of this renderer did exactly that, and every test
        // passed because every test drew opaque rectangles: a sprite batcher
        // that cannot do cut-outs is not a sprite batcher.
        //
        // The alpha channel blends the same way, so a page with premultiplied
        // colours would come out wrong — `tension_2d.h` says non-premultiplied
        // (the `screenshot` contract), and the decoders here produce
        // non-premultiplied.
        ctd.blend_state.enable_blend = true;
        ctd.blend_state.src_color_blendfactor = SDL_GPU_BLENDFACTOR_SRC_ALPHA;
        ctd.blend_state.dst_color_blendfactor = SDL_GPU_BLENDFACTOR_ONE_MINUS_SRC_ALPHA;
        ctd.blend_state.color_blend_op = SDL_GPU_BLENDOP_ADD;
        ctd.blend_state.src_alpha_blendfactor = SDL_GPU_BLENDFACTOR_ONE;
        ctd.blend_state.dst_alpha_blendfactor = SDL_GPU_BLENDFACTOR_ONE_MINUS_SRC_ALPHA;
        ctd.blend_state.alpha_blend_op = SDL_GPU_BLENDOP_ADD;

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
        for (auto &entry : atlases) {
            if (entry.second.array != nullptr) SDL_ReleaseGPUTexture(device, entry.second.array);
        }
        atlases.clear();
        if (implicit_array != nullptr) SDL_ReleaseGPUTexture(device, implicit_array);
        implicit_array = nullptr;
        implicit_source = 0;
        if (default_array != nullptr) SDL_ReleaseGPUTexture(device, default_array);
        default_array = nullptr;
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
        // The window must be released *before* the device it was claimed for.
        if (window != nullptr) {
            if (window_claimed) SDL_ReleaseWindowFromGPUDevice(device, window);
            SDL_DestroyWindow(window);
            window = nullptr;
            window_claimed = false;
        }
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

uint32_t Renderer::width() const { return impl_ ? impl_->canvas_width : 0u; }
uint32_t Renderer::height() const { return impl_ ? impl_->canvas_height : 0u; }
uint32_t Renderer::max_records() { return kMaxRecords; }
uint32_t Renderer::max_buckets() { return kMaxBuckets; }
uint32_t Renderer::max_atlas_pages() { return TENSION_2D_MAX_ATLAS_PAGES; }
uint32_t Renderer::pipeline_count() const {
    return impl_ ? static_cast<uint32_t>(impl_->pipelines.size()) : 0u;
}
uint32_t Renderer::texture_count() const {
    return impl_ ? static_cast<uint32_t>(impl_->textures.size()) : 0u;
}

int32_t Renderer::open(uint32_t width, uint32_t height, bool windowed, std::string &err) {
    if (is_open()) return -EBUSY;
    if (width == 0 || height == 0 || width > kMaxCanvasDimension ||
        height > kMaxCanvasDimension) {
        err = "open: canvas outside 1.." + std::to_string(kMaxCanvasDimension);
        return -EINVAL;
    }
    impl_->canvas_width = width;
    impl_->canvas_height = height;

    // SDL's video subsystem is refcounted process-wide; tension-input does the
    // same from its own thread. Both quit what they started.
    if (!SDL_Init(SDL_INIT_VIDEO)) {
        err = sdl_error("SDL_Init");
        return -ENODEV;
    }
    impl_->sdl_started = true;

    // `dummy` is a video driver with no GPU backend: `SDL_CreateGPUDevice` fails
    // against it with "No supported SDL_GPU backend found!", which reads as "this
    // machine has no GPU" when the real answer is "this driver has no GPU". A
    // headless run that sets it out of habit — SDL's own docs suggest it for
    // headless — then spends an afternoon on the wrong question. Refuse here,
    // by name, before the device is attempted.
    //
    // The errno is unchanged: this is the same `-ENODEV` the device-creation
    // failure would have produced, arrived at one step earlier and reported
    // honestly. `offscreen` is the driver that does have a GPU backend.
    if (const char *driver = SDL_GetCurrentVideoDriver();
        driver != nullptr && std::strcmp(driver, "dummy") == 0) {
        err = "open: SDL_VIDEODRIVER=dummy has no GPU backend — use offscreen for a "
              "headless run";
        impl_->release_all();
        return -ENODEV;
    }

    impl_->device = SDL_CreateGPUDevice(SDL_GPU_SHADERFORMAT_SPIRV, false, nullptr);
    if (impl_->device == nullptr) {
        // Distinguish "this build has no GPU backend" from "this machine has no
        // device" no further than SDL lets us: the message is what a reader gets.
        err = sdl_error("CreateGPUDevice");
        impl_->release_all();
        return -ENODEV;
    }

    if (windowed) {
        // A window the size of the canvas, at 1:1. SDL scales the swapchain to
        // the drawable size, so a HiDPI display shows the same 320x180 frame
        // larger rather than a crop of it.
        impl_->window = SDL_CreateWindow("Tension", static_cast<int>(width),
                                         static_cast<int>(height),
                                         SDL_WINDOW_RESIZABLE | SDL_WINDOW_HIGH_PIXEL_DENSITY);
        if (impl_->window == nullptr) {
            err = sdl_error("CreateWindow");
            impl_->release_all();
            return -ENODEV;
        }
        if (!SDL_ClaimWindowForGPUDevice(impl_->device, impl_->window)) {
            // A window the device cannot present to is not fatal for rendering;
            // it is fatal for *seeing* the frame, which is why it was asked for.
            err = sdl_error("ClaimWindowForGPUDevice");
            impl_->release_all();
            return -ENODEV;
        }
        impl_->window_claimed = true;
        SDL_SetGPUSwapchainParameters(impl_->device, impl_->window,
                                      SDL_GPU_SWAPCHAINCOMPOSITION_SDR,
                                      SDL_GPU_PRESENTMODE_VSYNC);
    }

    impl_->target = impl_->create_texture(width, height, SDL_GPU_TEXTUREUSAGE_COLOR_TARGET);
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

    // The array a bucket binds when it has none: sixteen 1x1 opaque white pages,
    // so a record that names no atlas still draws its rect — and a record that
    // names page 7 gets a defined texel rather than whatever the driver left in
    // an unwritten layer.
    {
        const uint8_t white[4] = {255, 255, 255, 255};
        SDL_GPUTexture *white_tex = nullptr;
        if (const int32_t rc = impl_->upload_rgba(white, 1, 1, &white_tex, err); rc != 0) {
            impl_->release_all();
            return rc;
        }
        impl_->default_array = impl_->create_array(1, 1);
        if (impl_->default_array == nullptr) {
            SDL_ReleaseGPUTexture(impl_->device, white_tex);
            err = sdl_error("CreateGPUTexture(default array)");
            impl_->release_all();
            return -ENOMEM;
        }
        for (uint32_t layer = 0; layer < TENSION_2D_MAX_ATLAS_PAGES; ++layer) {
            if (const int32_t rc = impl_->copy_into_layer(white_tex, impl_->default_array, layer, 1,
                                                          1, err);
                rc != 0) {
                SDL_ReleaseGPUTexture(impl_->device, white_tex);
                impl_->release_all();
                return rc;
            }
        }
        SDL_ReleaseGPUTexture(impl_->device, white_tex);
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

uint64_t graph_hash(const uint8_t *bytes, size_t len) {
    uint64_t hash = 0xcbf29ce484222325ull;
    for (size_t i = 0; i < len; ++i) {
        hash ^= static_cast<uint64_t>(bytes[i]);
        hash *= 0x100000001b3ull;
    }
    return hash;
}

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
    // with is -ENOSYS from here; the adapter catches that and asks the host's
    // `compile_graph` to compile it (adapter.cpp:187-231).
    const uint64_t hash = graph_hash(blob, len);
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

bool Renderer::has_builtin_graph(uint64_t hash) const {
    for (const auto &candidate : kGraphPipes) {
        if (candidate.hash == hash) return true;
    }
    return false;
}

int32_t Renderer::set_pipeline_spirv(const uint8_t *vs, size_t vs_len, const uint8_t *fs,
                                     size_t fs_len, uint32_t &pipe_id, std::string &err) {
    if (!is_open()) return -ENODEV;
    if (vs == nullptr || fs == nullptr || vs_len < 4 || fs_len < 4) {
        err = "set_pipeline: empty module from the compiler";
        return -EINVAL;
    }
    if (impl_->pipelines.size() >= kMaxPipelines) {
        err = "set_pipeline: pipeline table full";
        return -ENOSPC;
    }
    // 1000 upward: the range tension_2d.h reserves for runtime-compiled graphs,
    // so a pipe_id tells a log reader where the modules came from.
    const uint32_t id = impl_->next_runtime_pipe++;
    if (const int32_t rc = impl_->build_pipeline(vs, vs_len, fs, fs_len, id, err); rc != 0) {
        return rc;
    }
    pipe_id = id;
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

    // Resolve every span's atlas before recording: creating one submits a copy
    // of its own, and a command buffer is cleaner to acquire outside the frame's.
    for (const auto &span : spans) {
        if (impl_->atlases.find(span.pipe_id) != impl_->atlases.end()) continue;
        // No explicit pages: the pipeline samples the most recently loaded
        // texture at page 0. That is the v1 behaviour every caller had before
        // `set_texture` existed, kept so `tex = 0` still means "my atlas".
        if (impl_->bound_texture == 0) continue;
        if (impl_->implicit_array != nullptr && impl_->implicit_source == impl_->bound_texture) {
            continue;
        }
        auto source = impl_->textures.find(impl_->bound_texture);
        if (source == impl_->textures.end()) continue;
        if (impl_->implicit_array != nullptr) {
            SDL_ReleaseGPUTexture(impl_->device, impl_->implicit_array);
            impl_->implicit_array = nullptr;
        }
        impl_->implicit_array = impl_->create_array(source->second.width, source->second.height);
        if (impl_->implicit_array == nullptr) {
            err = sdl_error("CreateGPUTexture(atlas)");
            return -ENOMEM;
        }
        impl_->implicit_width = source->second.width;
        impl_->implicit_height = source->second.height;
        if (const int32_t rc = impl_->copy_into_layer(source->second.texture, impl_->implicit_array,
                                                      0, source->second.width,
                                                      source->second.height, err);
            rc != 0) {
            return rc;
        }
        impl_->implicit_source = impl_->bound_texture;
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

    // A present with nothing submitted re-presents the frame already in the
    // target. That is what makes a windowed handle usable: the guest draws once,
    // then loops on `present` to keep the window up, and an empty present that
    // cleared to black would flash the screen instead of holding the image.
    // The first present on a handle always draws, so there is never a "stale
    // frame from a previous handle" to inherit.
    const bool repaint = frame.empty() && impl_->presented_once;

    if (!repaint) {
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

        for (const auto &span : spans) {
            if (span.count == 0) continue;
            auto pipeline = impl_->pipelines.find(span.pipe_id);
            if (pipeline == impl_->pipelines.end()) continue;
            if (span.pipe_id != bound_pipe) {
                SDL_BindGPUGraphicsPipeline(pass, pipeline->second);
                bound_pipe = span.pipe_id;
            }

            // The atlas is per pipeline, so the uniform and the sampler binding
            // move with the span rather than being set once per frame. The
            // block is `{ vec2 u_canvas_half; vec2 u_tex_size; }`: the canvas
            // projects pixels to clip, the page size normalizes the record's
            // pixel src rect before sampling.
            SDL_GPUTexture *atlas = impl_->default_array;
            float tex_w = 1.0f;
            float tex_h = 1.0f;
            auto explicit_atlas = impl_->atlases.find(span.pipe_id);
            if (explicit_atlas != impl_->atlases.end() && explicit_atlas->second.pages > 0) {
                atlas = explicit_atlas->second.array;
                tex_w = static_cast<float>(explicit_atlas->second.width);
                tex_h = static_cast<float>(explicit_atlas->second.height);
            } else if (impl_->implicit_array != nullptr) {
                atlas = impl_->implicit_array;
                tex_w = static_cast<float>(impl_->implicit_width);
                tex_h = static_cast<float>(impl_->implicit_height);
            }
            const float uniforms[4] = {static_cast<float>(impl_->canvas_width) * 0.5f,
                                       static_cast<float>(impl_->canvas_height) * 0.5f, tex_w,
                                       tex_h};
            SDL_PushGPUVertexUniformData(cmd, 0, uniforms, sizeof uniforms);

            SDL_GPUTextureSamplerBinding tex = {};
            tex.texture = atlas;
            tex.sampler = impl_->sampler;
            SDL_BindGPUFragmentSamplers(pass, 0, &tex, 1);

            SDL_DrawGPUPrimitives(pass, 6, span.count, 0, span.first);
        }
    }

        SDL_EndGPURenderPass(pass);
    }

    // Presentation. The frame was drawn into `target`; a windowed handle copies
    // it into the swapchain image instead of (well, as well as) waiting for a
    // readback. A blit rather than a second render pass because the target and
    // the swapchain may differ in format, and `SDL_BlitGPUTexture` is the one
    // call that handles a format change without a pipeline per format.
    if (impl_->window != nullptr) {
        // Pump events before acquiring: a closed window has no swapchain, and
        // asking for one would be an error every frame after the user quits.
        SDL_PumpEvents();
        SDL_Event event;
        while (SDL_PollEvent(&event)) {
            if (event.type == SDL_EVENT_QUIT ||
                (event.type == SDL_EVENT_WINDOW_CLOSE_REQUESTED &&
                 event.window.windowID == SDL_GetWindowID(impl_->window))) {
                impl_->window_closed = true;
            }
        }
        if (!impl_->window_closed) {
            SDL_GPUTexture *swapchain = nullptr;
            uint32_t swap_w = 0;
            uint32_t swap_h = 0;
            if (!SDL_WaitAndAcquireGPUSwapchainTexture(cmd, impl_->window, &swapchain, &swap_w,
                                                       &swap_h)) {
                SDL_CancelGPUCommandBuffer(cmd);
                err = sdl_error("AcquireGPUSwapchainTexture");
                return -EIO;
            }
            if (swapchain != nullptr) {
                SDL_GPUBlitInfo blit = {};
                blit.source.texture = impl_->target;
                blit.source.w = impl_->canvas_width;
                blit.source.h = impl_->canvas_height;
                blit.destination.texture = swapchain;
                blit.destination.w = swap_w;
                blit.destination.h = swap_h;
                blit.load_op = SDL_GPU_LOADOP_DONT_CARE;
                blit.filter = SDL_GPU_FILTER_NEAREST;
                SDL_BlitGPUTexture(cmd, &blit);
            }
        }
    }

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

    // One clear message when the user closes the window, rather than a failure
    // per frame afterwards. The guest's next verb sees a normal return; the
    // frame simply stops appearing.
    if (impl_->window_closed && !impl_->window_close_reported) {
        impl_->window_close_reported = true;
        err = "present: the window was closed";
        return -ECANCELED;
    }
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
    // The most recently loaded texture is the one a pipeline with no explicit
    // `set_texture` pages samples at page 0 — the single-atlas behaviour every
    // v1 caller relies on. Explicit page binding is `set_texture`.
    impl_->bound_texture = id;
    texture_id = id;
    return 0;
}

int32_t Renderer::set_texture(uint32_t pipe_id, uint32_t slot, uint32_t texture_id,
                              std::string &err) {
    if (!is_open()) return -ENODEV;
    if (impl_->pipelines.find(pipe_id) == impl_->pipelines.end()) {
        err = "set_texture: unknown pipe_id " + std::to_string(pipe_id);
        return -ENOENT;
    }
    if (slot >= TENSION_2D_MAX_ATLAS_PAGES) {
        err = "set_texture: page " + std::to_string(slot) + " outside 0.." +
              std::to_string(TENSION_2D_MAX_ATLAS_PAGES - 1);
        return -EINVAL;
    }
    auto texture = impl_->textures.find(texture_id);
    if (texture == impl_->textures.end()) {
        err = "set_texture: unknown texture id " + std::to_string(texture_id);
        return -ENOENT;
    }

    Atlas &atlas = impl_->atlases[pipe_id];
    if (atlas.array == nullptr) {
        // An array texture has one size for every page. The first page bound to
        // a pipeline fixes it; a page of another size is refused rather than
        // resampled, because resampling moves pixels inside a cell and the
        // record's src rect is in pixels.
        atlas.array = impl_->create_array(texture->second.width, texture->second.height);
        if (atlas.array == nullptr) {
            impl_->atlases.erase(pipe_id);
            err = sdl_error("CreateGPUTexture(atlas)");
            return -ENOMEM;
        }
        atlas.width = texture->second.width;
        atlas.height = texture->second.height;
    } else if (atlas.width != texture->second.width || atlas.height != texture->second.height) {
        err = "set_texture: texture " + std::to_string(texture_id) + " is " +
              std::to_string(texture->second.width) + "x" + std::to_string(texture->second.height) +
              ", the pipeline's atlas is " + std::to_string(atlas.width) + "x" +
              std::to_string(atlas.height) +
              " — every page of one pipeline shares the array's size";
        return -EINVAL;
    }

    if (atlas.bound[slot] != texture_id) {
        if (const int32_t rc = impl_->copy_into_layer(texture->second.texture, atlas.array, slot,
                                                      atlas.width, atlas.height, err);
            rc != 0) {
            return rc;
        }
        atlas.bound[slot] = texture_id;
    }
    if (atlas.pages == 0) atlas.pages = 1;
    return 0;
}

int32_t Renderer::screenshot(uint8_t *dst, size_t cap, size_t &written, std::string &err) {
    if (!is_open()) return -ENODEV;
    if (!impl_->presented_once) {
        err = "screenshot: nothing has been presented";
        return -ENODEV;
    }

    const size_t bytes = static_cast<size_t>(impl_->canvas_width) * impl_->canvas_height * 4u;
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
    region.w = impl_->canvas_width;
    region.h = impl_->canvas_height;
    region.d = 1;
    SDL_GPUTextureTransferInfo info = {};
    info.transfer_buffer = impl_->download;
    info.pixels_per_row = impl_->canvas_width;
    info.rows_per_layer = impl_->canvas_height;
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
