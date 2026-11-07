/*
 * sprite_batch.c — the SDL_GPU sprite-batcher cost probe.
 *
 * Why this file exists
 * --------------------
 * DESIGN.md §7 argued the 2D adapter's rendering path from a figure nobody in
 * the tree could reproduce: "~0.06 ms at 1k–10k sprites", reported from a
 * planning probe rather than measured in the repository. A budget written
 * against an unciteable number is a budget nobody can check, so this probe
 * re-measures it and results.txt records the answer with its host.
 *
 * What it measures
 * ----------------
 * The per-bucket cost of the pattern §7 specifies, nothing else:
 *
 *   1. N records of 28 bytes (DESIGN.md §5) sit in a host array.
 *   2. Each frame they are copied into a transfer buffer, uploaded to a
 *      GRAPHICS_STORAGE_READ buffer with one copy pass, and drawn with one
 *      SDL_DrawGPUPrimitives(6, N, 0, 0).
 *   3. The vertex shader reads the record at gl_InstanceIndex and synthesizes
 *      the quad. There is no vertex buffer and no CPU expansion.
 *
 * Two numbers are reported per N, because they answer different questions:
 *
 *   cpu_ms    — frame start to submit-return. This is the CPU cost of the
 *               batcher: the upload copy plus the command encoding. It is the
 *               number the "cost per bucket" claim is about, and it does not
 *               depend on how fast the GPU is.
 *   total_ms  — the same frame plus SDL_WaitForGPUIdle. On real hardware this
 *               is bounded by GPU work; on a software rasteriser it is bounded
 *               by fill rate and says nothing about a GPU.
 *
 * Median of 31 frames after 10 warm-up frames, per N.
 *
 * The smoke test
 * --------------
 * After the timing loop the probe downloads the render target with
 * SDL_DownloadFromGPUTexture and counts non-black pixels. A bench that reports
 * a fast frame while drawing nothing is worse than no bench, so this asserts
 * that the pipeline actually ran.
 *
 * Caveat this file cannot fix: the host that runs it may have no GPU. Check
 * results.txt, which records the device driver SDL chose. A `dzn`/`lavapipe`/
 * `swiftshader` driver makes total_ms meaningless as a hardware figure and
 * leaves cpu_ms as the only transferable measurement.
 *
 * SPDX-License-Identifier: MIT
 */

#include <SDL3/SDL.h>

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define CANVAS_W   1920u
#define CANVAS_H   1080u
#define RECORD_BYTES 28u
#define WARMUP_FRAMES 10
#define SAMPLE_FRAMES 31

/* The `sprite` preset record, DESIGN.md §5. Laid out explicitly so the bench
 * fails loudly if anyone changes the offsets without changing this struct. */
typedef struct Sprite {
    Sint32   x;          /*  0 */
    Sint32   y;          /*  4 */
    Uint16   src_x;      /*  8 */
    Uint16   src_y;      /* 10 */
    Uint16   w;          /* 12 */
    Uint16   h;          /* 14 */
    Uint16   tex;        /* 16 */
    Uint16   pad;        /* 18 — the two bytes that make sort_key 4-aligned */
    Uint32   sort_key;   /* 20 */
    Uint16   group_id;   /* 24 */
    Uint8    z;          /* 26 */
    Uint8    flags;      /* 27 */
} Sprite;

SDL_COMPILE_TIME_ASSERT(sprite_is_28, sizeof(Sprite) == RECORD_BYTES);

static int cmp_double(const void *a, const void *b) {
    const double x = *(const double *)a, y = *(const double *)b;
    return (x > y) - (x < y);
}

static double median(double *v, int n) {
    qsort(v, (size_t)n, sizeof *v, cmp_double);
    return (n % 2) ? v[n / 2] : 0.5 * (v[n / 2 - 1] + v[n / 2]);
}

static void die(const char *what) {
    fprintf(stderr, "FAIL %s: %s\n", what, SDL_GetError());
    exit(1);
}

static Uint8 *read_file(const char *path, size_t *out_size) {
    FILE *f = fopen(path, "rb");
    if (!f) { fprintf(stderr, "cannot open %s\n", path); exit(1); }
    fseek(f, 0, SEEK_END);
    const long len = ftell(f);
    fseek(f, 0, SEEK_SET);
    Uint8 *buf = (Uint8 *)malloc((size_t)len);
    if (!buf || fread(buf, 1, (size_t)len, f) != (size_t)len) {
        fprintf(stderr, "cannot read %s\n", path);
        exit(1);
    }
    fclose(f);
    *out_size = (size_t)len;
    return buf;
}

/*
 * Lay N sprites out so they tile the canvas at every N.
 *
 * The point is to hold fill work roughly constant across the sweep, so what
 * changes between 1024 and 100000 sprites is the per-instance work and not the
 * overdraw. A fixed sprite size would make the large-N numbers a fill-rate
 * measurement of whatever rasteriser the host happens to have.
 */
static void fill_sprites(Sprite *s, Uint32 n) {
    const double area = (double)CANVAS_W * (double)CANVAS_H / (double)n;
    Uint32 px = (Uint32)sqrt(area);
    if (px < 2u) px = 2u;
    if (px > 64u) px = 64u;
    const Uint32 cols = CANVAS_W / px;
    for (Uint32 i = 0; i < n; i++) {
        s[i].x        = (Sint32)((i % cols) * px);
        s[i].y        = (Sint32)((i / cols) * px);
        s[i].src_x    = 0;
        s[i].src_y    = 0;
        s[i].w        = (Uint16)px;
        s[i].h        = (Uint16)px;
        s[i].tex      = 0;
        s[i].pad      = 0;
        s[i].sort_key = i;
        s[i].group_id = 0;
        s[i].z        = 0;
        s[i].flags    = 0;
    }
}

typedef struct {
    Uint32 n;
    double cpu_ms;
    double total_ms;
    int    nonblack_px;
} Result;

/*
 * The fixed cost of a frame that draws nothing: acquire, clear, submit, wait.
 *
 * Without it, a per-bucket number silently includes the command-buffer and
 * submission overhead that every frame pays once regardless of how many
 * sprites it carries. Subtracting it is what makes "cost per bucket" mean what
 * DESIGN.md §7 says it means.
 */
static void measure_baseline(SDL_GPUDevice *dev, double *cpu_ms, double *total_ms) {
    SDL_GPUTextureCreateInfo tti = { 0 };
    tti.type                 = SDL_GPU_TEXTURETYPE_2D;
    tti.format               = SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM;
    tti.usage                = SDL_GPU_TEXTUREUSAGE_COLOR_TARGET;
    tti.width                = CANVAS_W;
    tti.height               = CANVAS_H;
    tti.layer_count_or_depth = 1;
    tti.num_levels           = 1;
    tti.sample_count         = SDL_GPU_SAMPLECOUNT_1;
    SDL_GPUTexture *target = SDL_CreateGPUTexture(dev, &tti);
    if (!target) die("CreateGPUTexture(baseline)");

    const SDL_FColor clear = { 0.0f, 0.0f, 0.0f, 1.0f };
    const Uint64 freq = SDL_GetPerformanceFrequency();
    double *cpu = (double *)calloc(SAMPLE_FRAMES, sizeof(double));
    double *tot = (double *)calloc(SAMPLE_FRAMES, sizeof(double));
    if (!cpu || !tot) die("calloc baseline");

    for (int frame = 0; frame < WARMUP_FRAMES + SAMPLE_FRAMES; frame++) {
        const Uint64 t0 = SDL_GetPerformanceCounter();
        SDL_GPUCommandBuffer *cmd = SDL_AcquireGPUCommandBuffer(dev);
        if (!cmd) die("AcquireGPUCommandBuffer(baseline)");
        SDL_GPUColorTargetInfo cti = { 0 };
        cti.texture     = target;
        cti.clear_color = clear;
        cti.load_op     = SDL_GPU_LOADOP_CLEAR;
        cti.store_op    = SDL_GPU_STOREOP_STORE;
        SDL_GPURenderPass *pass = SDL_BeginGPURenderPass(cmd, &cti, 1, NULL);
        if (!pass) die("BeginGPURenderPass(baseline)");
        SDL_EndGPURenderPass(pass);
        if (!SDL_SubmitGPUCommandBuffer(cmd)) die("SubmitGPUCommandBuffer(baseline)");
        const Uint64 t1 = SDL_GetPerformanceCounter();
        if (!SDL_WaitForGPUIdle(dev)) die("WaitForGPUIdle(baseline)");
        const Uint64 t2 = SDL_GetPerformanceCounter();
        if (frame >= WARMUP_FRAMES) {
            const int k = frame - WARMUP_FRAMES;
            cpu[k] = (double)(t1 - t0) * 1000.0 / (double)freq;
            tot[k] = (double)(t2 - t0) * 1000.0 / (double)freq;
        }
    }

    *cpu_ms   = median(cpu, SAMPLE_FRAMES);
    *total_ms = median(tot, SAMPLE_FRAMES);
    free(cpu);
    free(tot);
    SDL_ReleaseGPUTexture(dev, target);
}

static Result run_one(SDL_GPUDevice *dev,
                      SDL_GPUGraphicsPipeline *pipe,
                      SDL_GPUSampler *sampler,
                      SDL_GPUTexture *white,
                      Uint32 n,
                      const char *spv_dir) {
    (void)spv_dir;
    Result r = { n, 0.0, 0.0, 0 };

    const Uint32 bytes = n * RECORD_BYTES;
    Sprite *sprites = (Sprite *)calloc(n, sizeof(Sprite));
    if (!sprites) die("calloc sprites");
    fill_sprites(sprites, n);

    SDL_GPUBufferCreateInfo bci = { 0 };
    bci.usage = SDL_GPU_BUFFERUSAGE_GRAPHICS_STORAGE_READ;
    bci.size  = bytes;
    SDL_GPUBuffer *storage = SDL_CreateGPUBuffer(dev, &bci);
    if (!storage) die("CreateGPUBuffer");

    SDL_GPUTransferBufferCreateInfo tci = { 0 };
    tci.usage = SDL_GPU_TRANSFERBUFFERUSAGE_UPLOAD;
    tci.size  = bytes;
    SDL_GPUTransferBuffer *xfer = SDL_CreateGPUTransferBuffer(dev, &tci);
    if (!xfer) die("CreateGPUTransferBuffer(upload)");

    /* Render target: offscreen, RGBA8, downloadable and samplable. */
    SDL_GPUTextureCreateInfo tti = { 0 };
    tti.type                 = SDL_GPU_TEXTURETYPE_2D;
    tti.format               = SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM;
    tti.usage                = SDL_GPU_TEXTUREUSAGE_COLOR_TARGET;
    tti.width                = CANVAS_W;
    tti.height               = CANVAS_H;
    tti.layer_count_or_depth = 1;
    tti.num_levels           = 1;
    tti.sample_count         = SDL_GPU_SAMPLECOUNT_1;
    SDL_GPUTexture *target = SDL_CreateGPUTexture(dev, &tti);
    if (!target) die("CreateGPUTexture(target)");

    const Uint64 freq = SDL_GetPerformanceFrequency();
    double *cpu = (double *)calloc(SAMPLE_FRAMES, sizeof(double));
    double *tot = (double *)calloc(SAMPLE_FRAMES, sizeof(double));
    if (!cpu || !tot) die("calloc timings");

    const SDL_FColor clear = { 0.0f, 0.0f, 0.0f, 1.0f };

    for (int frame = 0; frame < WARMUP_FRAMES + SAMPLE_FRAMES; frame++) {
        const Uint64 t0 = SDL_GetPerformanceCounter();

        void *mapped = SDL_MapGPUTransferBuffer(dev, xfer, true);
        if (!mapped) die("MapGPUTransferBuffer");
        memcpy(mapped, sprites, bytes);
        SDL_UnmapGPUTransferBuffer(dev, xfer);

        SDL_GPUCommandBuffer *cmd = SDL_AcquireGPUCommandBuffer(dev);
        if (!cmd) die("AcquireGPUCommandBuffer");

        SDL_GPUCopyPass *copy = SDL_BeginGPUCopyPass(cmd);
        SDL_GPUTransferBufferLocation src = { 0 };
        src.transfer_buffer = xfer;
        src.offset = 0;
        SDL_GPUBufferRegion dst = { 0 };
        dst.buffer = storage;
        dst.offset = 0;
        dst.size   = bytes;
        SDL_UploadToGPUBuffer(copy, &src, &dst, true);
        SDL_EndGPUCopyPass(copy);

        SDL_GPUColorTargetInfo cti = { 0 };
        cti.texture    = target;
        cti.clear_color = clear;
        cti.load_op    = SDL_GPU_LOADOP_CLEAR;
        cti.store_op   = SDL_GPU_STOREOP_STORE;
        SDL_GPURenderPass *pass = SDL_BeginGPURenderPass(cmd, &cti, 1, NULL);
        if (!pass) die("BeginGPURenderPass");

        SDL_BindGPUGraphicsPipeline(pass, pipe);

        SDL_GPUBuffer *bound[1] = { storage };
        SDL_BindGPUVertexStorageBuffers(pass, 0, bound, 1);

        SDL_GPUTextureSamplerBinding texbind = { 0 };
        texbind.texture = white;
        texbind.sampler = sampler;
        SDL_BindGPUFragmentSamplers(pass, 0, &texbind, 1);

        SDL_DrawGPUPrimitives(pass, 6, n, 0, 0);

        SDL_EndGPURenderPass(pass);
        if (!SDL_SubmitGPUCommandBuffer(cmd)) die("SubmitGPUCommandBuffer");

        const Uint64 t1 = SDL_GetPerformanceCounter();
        if (!SDL_WaitForGPUIdle(dev)) die("WaitForGPUIdle");
        const Uint64 t2 = SDL_GetPerformanceCounter();

        if (frame >= WARMUP_FRAMES) {
            const int k = frame - WARMUP_FRAMES;
            cpu[k] = (double)(t1 - t0) * 1000.0 / (double)freq;
            tot[k] = (double)(t2 - t0) * 1000.0 / (double)freq;
        }
    }

    r.cpu_ms   = median(cpu, SAMPLE_FRAMES);
    r.total_ms = median(tot, SAMPLE_FRAMES);

    /* Smoke test: the frame must contain something. */
    const Uint32 dl_bytes = CANVAS_W * CANVAS_H * 4u;
    SDL_GPUTransferBufferCreateInfo dci = { 0 };
    dci.usage = SDL_GPU_TRANSFERBUFFERUSAGE_DOWNLOAD;
    dci.size  = dl_bytes;
    SDL_GPUTransferBuffer *down = SDL_CreateGPUTransferBuffer(dev, &dci);
    if (!down) die("CreateGPUTransferBuffer(download)");

    SDL_GPUCommandBuffer *dcmd = SDL_AcquireGPUCommandBuffer(dev);
    if (!dcmd) die("AcquireGPUCommandBuffer(download)");
    SDL_GPUCopyPass *dcopy = SDL_BeginGPUCopyPass(dcmd);
    SDL_GPUTextureRegion region = { 0 };
    region.texture = target;
    region.w = CANVAS_W;
    region.h = CANVAS_H;
    region.d = 1;
    SDL_GPUTextureTransferInfo dti = { 0 };
    dti.transfer_buffer = down;
    dti.offset = 0;
    dti.pixels_per_row = CANVAS_W;
    dti.rows_per_layer = CANVAS_H;
    SDL_DownloadFromGPUTexture(dcopy, &region, &dti);
    SDL_EndGPUCopyPass(dcopy);
    if (!SDL_SubmitGPUCommandBuffer(dcmd)) die("SubmitGPUCommandBuffer(download)");
    if (!SDL_WaitForGPUIdle(dev)) die("WaitForGPUIdle(download)");

    const Uint8 *px = (const Uint8 *)SDL_MapGPUTransferBuffer(dev, down, false);
    if (!px) die("MapGPUTransferBuffer(download)");
    for (Uint32 i = 0; i < CANVAS_W * CANVAS_H; i++) {
        if (px[i * 4u] || px[i * 4u + 1u] || px[i * 4u + 2u]) r.nonblack_px++;
    }
    SDL_UnmapGPUTransferBuffer(dev, down);

    SDL_ReleaseGPUTransferBuffer(dev, down);
    SDL_ReleaseGPUTexture(dev, target);
    SDL_ReleaseGPUTransferBuffer(dev, xfer);
    SDL_ReleaseGPUBuffer(dev, storage);
    free(cpu);
    free(tot);
    free(sprites);
    return r;
}

int main(int argc, char **argv) {
    const char *spv_dir = ".";
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--spv") == 0 && i + 1 < argc) spv_dir = argv[++i];
    }

    char vs_path[512], fs_path[512];
    snprintf(vs_path, sizeof vs_path, "%s/sprite.vert.spv", spv_dir);
    snprintf(fs_path, sizeof fs_path, "%s/sprite.frag.spv", spv_dir);

    if (!SDL_Init(SDL_INIT_VIDEO)) die("SDL_Init");

    printf("# sprite-batch probe\n");
    printf("video_driver: %s\n", SDL_GetCurrentVideoDriver());
    printf("canvas: %ux%u\n", CANVAS_W, CANVAS_H);
    printf("record_bytes: %u\n", RECORD_BYTES);
    printf("samples: %d warmup: %d\n", SAMPLE_FRAMES, WARMUP_FRAMES);

    SDL_GPUDevice *dev = SDL_CreateGPUDevice(SDL_GPU_SHADERFORMAT_SPIRV, true, NULL);
    if (!dev) die("CreateGPUDevice");
    printf("gpu_driver: %s\n", SDL_GetGPUDeviceDriver(dev));

    size_t vs_len = 0, fs_len = 0;
    Uint8 *vs_code = read_file(vs_path, &vs_len);
    Uint8 *fs_code = read_file(fs_path, &fs_len);

    SDL_GPUShaderCreateInfo vsi = { 0 };
    vsi.code = vs_code;
    vsi.code_size = vs_len;
    vsi.entrypoint = "main";
    vsi.format = SDL_GPU_SHADERFORMAT_SPIRV;
    vsi.stage = SDL_GPU_SHADERSTAGE_VERTEX;
    vsi.num_storage_buffers = 1;
    SDL_GPUShader *vs = SDL_CreateGPUShader(dev, &vsi);
    if (!vs) die("CreateGPUShader(VS)");

    SDL_GPUShaderCreateInfo fsi = { 0 };
    fsi.code = fs_code;
    fsi.code_size = fs_len;
    fsi.entrypoint = "main";
    fsi.format = SDL_GPU_SHADERFORMAT_SPIRV;
    fsi.stage = SDL_GPU_SHADERSTAGE_FRAGMENT;
    fsi.num_samplers = 1;
    SDL_GPUShader *fs = SDL_CreateGPUShader(dev, &fsi);
    if (!fs) die("CreateGPUShader(FS)");

    SDL_GPUColorTargetDescription ctd = { 0 };
    ctd.format = SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM;

    SDL_GPUGraphicsPipelineCreateInfo pci = { 0 };
    pci.vertex_shader   = vs;
    pci.fragment_shader = fs;
    pci.primitive_type  = SDL_GPU_PRIMITIVETYPE_TRIANGLELIST;
    pci.rasterizer_state.fill_mode = SDL_GPU_FILLMODE_FILL;
    pci.rasterizer_state.cull_mode = SDL_GPU_CULLMODE_NONE;
    pci.multisample_state.sample_count = SDL_GPU_SAMPLECOUNT_1;
    pci.target_info.color_target_descriptions = &ctd;
    pci.target_info.num_color_targets = 1;
    SDL_GPUGraphicsPipeline *pipe = SDL_CreateGPUGraphicsPipeline(dev, &pci);
    if (!pipe) die("CreateGPUGraphicsPipeline");

    /* A 1x1 white texture: the fragment stage samples it, so the draw is a real
     * textured draw and the smoke test has something to find. */
    SDL_GPUTextureCreateInfo wci = { 0 };
    wci.type = SDL_GPU_TEXTURETYPE_2D;
    wci.format = SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM;
    wci.usage = SDL_GPU_TEXTUREUSAGE_SAMPLER;
    wci.width = 1;
    wci.height = 1;
    wci.layer_count_or_depth = 1;
    wci.num_levels = 1;
    wci.sample_count = SDL_GPU_SAMPLECOUNT_1;
    SDL_GPUTexture *white = SDL_CreateGPUTexture(dev, &wci);
    if (!white) die("CreateGPUTexture(white)");

    SDL_GPUSamplerCreateInfo sci = { 0 };
    sci.min_filter = SDL_GPU_FILTER_NEAREST;
    sci.mag_filter = SDL_GPU_FILTER_NEAREST;
    sci.mipmap_mode = SDL_GPU_SAMPLERMIPMAPMODE_NEAREST;
    sci.address_mode_u = SDL_GPU_SAMPLERADDRESSMODE_CLAMP_TO_EDGE;
    sci.address_mode_v = SDL_GPU_SAMPLERADDRESSMODE_CLAMP_TO_EDGE;
    sci.address_mode_w = SDL_GPU_SAMPLERADDRESSMODE_CLAMP_TO_EDGE;
    SDL_GPUSampler *sampler = SDL_CreateGPUSampler(dev, &sci);
    if (!sampler) die("CreateGPUSampler");

    {
        const Uint8 white_px[4] = { 255, 255, 255, 255 };
        SDL_GPUTransferBufferCreateInfo uci = { 0 };
        uci.usage = SDL_GPU_TRANSFERBUFFERUSAGE_UPLOAD;
        uci.size  = 4;
        SDL_GPUTransferBuffer *up = SDL_CreateGPUTransferBuffer(dev, &uci);
        if (!up) die("CreateGPUTransferBuffer(white)");
        void *m = SDL_MapGPUTransferBuffer(dev, up, false);
        memcpy(m, white_px, 4);
        SDL_UnmapGPUTransferBuffer(dev, up);

        SDL_GPUCommandBuffer *cmd = SDL_AcquireGPUCommandBuffer(dev);
        SDL_GPUCopyPass *cp = SDL_BeginGPUCopyPass(cmd);
        SDL_GPUTextureTransferInfo ti = { 0 };
        ti.transfer_buffer = up;
        ti.pixels_per_row = 1;
        ti.rows_per_layer = 1;
        SDL_GPUTextureRegion reg = { 0 };
        reg.texture = white;
        reg.w = 1;
        reg.h = 1;
        reg.d = 1;
        SDL_UploadToGPUTexture(cp, &ti, &reg, true);
        SDL_EndGPUCopyPass(cp);
        if (!SDL_SubmitGPUCommandBuffer(cmd)) die("SubmitGPUCommandBuffer(white)");
        if (!SDL_WaitForGPUIdle(dev)) die("WaitForGPUIdle(white)");
        SDL_ReleaseGPUTransferBuffer(dev, up);
    }

    const Uint32 sweep[] = { 1024u, 10000u, 50000u, 100000u };

    double base_cpu = 0.0, base_total = 0.0;
    measure_baseline(dev, &base_cpu, &base_total);
    printf("\nbaseline (empty frame, no draw): cpu %.3f ms, total %.3f ms\n",
           base_cpu, base_total);

    printf("\n%-8s %10s %10s %12s %12s\n",
           "N", "cpu_ms", "net_cpu_ms", "total_ms", "nonblack_px");
    for (size_t i = 0; i < sizeof sweep / sizeof sweep[0]; i++) {
        const Result r = run_one(dev, pipe, sampler, white, sweep[i], spv_dir);
        printf("%-8u %10.3f %10.3f %12.3f %12d\n",
               r.n, r.cpu_ms, r.cpu_ms - base_cpu, r.total_ms, r.nonblack_px);
        if (r.nonblack_px == 0) {
            fprintf(stderr, "FAIL: N=%u drew no pixels — the pipeline did not run\n", r.n);
            return 1;
        }
    }

    SDL_ReleaseGPUSampler(dev, sampler);
    SDL_ReleaseGPUTexture(dev, white);
    SDL_ReleaseGPUGraphicsPipeline(dev, pipe);
    SDL_ReleaseGPUShader(dev, vs);
    SDL_ReleaseGPUShader(dev, fs);
    free(vs_code);
    free(fs_code);
    SDL_DestroyGPUDevice(dev);
    SDL_Quit();
    return 0;
}
