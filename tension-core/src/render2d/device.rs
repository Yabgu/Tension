//! The 2D renderer, in core: device, canvas, pipelines, textures, buckets.
//!
//! This is `tension-2d/src/render.cpp` ported. The C++ file was 1,151 lines
//! because it owned the device, the window, the target, the pipeline table, the
//! texture and atlas tables, the frame stager and the presentation path — all of
//! which still have to happen. What went away is the ABI edge around it: no
//! `tension_value`, no `read_guest`, no `refuse`/`answer`, no advertising of ten
//! verbs. The mechanics are here; the verb bodies are `main.rs`'s.
//!
//! # What changed, and what deliberately did not
//!
//! **Changed.** The window is the host's, claimed rather than created
//! (`SDL_ClaimWindowForGPUDevice` on `HostWindow`'s `SDL_Window`), and it is
//! created on demand at the size the renderer declares. The graph compiler is a
//! function call instead of a two-call ABI round trip (`pipeline.rs`). Resource
//! release is Rust `Drop` instead of `release_all`'s hand-written unwind.
//!
//! **Not changed.** The frame is the same frame. Buckets are gathered in
//! ascending id, stably sorted by the graph's key list, concatenated into one
//! storage-buffer upload, and drawn as one instanced call per bucket. The clear
//! colour, the blend state, the sampler, the uniform block, the blit and the
//! readback are the C++ values, because `tests/render2d_parity.rs` compares the
//! two implementations' pixels and the comparison is the point.
//!
//! # Threading
//!
//! Everything runs on the interpreter thread, which is the thread that created
//! any window that exists. `SDL_ClaimWindowForGPUDevice` requires that
//! (`SDL_gpu.h:4140-4142`) and `sdl3`'s `Window` is not `Send`, so the rule is
//! enforced by the type system rather than by a convention in a comment.
//!
//! SPDX-License-Identifier: MIT

use std::collections::BTreeMap;

use sdl3::gpu::{
    Buffer, BufferUsageFlags, Device, Filter, LoadOp, Sampler, SamplerAddressMode,
    SamplerMipmapMode, SampleCount, ShaderFormat, StoreOp, Texture, TextureCreateInfo,
    TextureFormat, TextureType, TextureUsage, TransferBuffer, TransferBufferUsage,
};
use sdl3::pixels::Color;

use crate::platform::HostWindow;
use crate::render2d::error::Render2dError;
use crate::render2d::iwi::decode_iwi;
use crate::render2d::pipeline::PipelineCache;
use crate::render2d::record::{self, InfoRecord, RECORD_SIZE};

/// `TENSION_2D_MAX_ATLAS_PAGES` — the layer count of a pipeline's texture array.
pub const MAX_ATLAS_PAGES: usize = 16;
/// Records the stager holds across all buckets.
pub const MAX_RECORDS: usize = 4096;
/// Buckets (draw calls) one frame may have.
pub const MAX_BUCKETS: u32 = 8;
/// Textures one canvas may hold.
pub const MAX_TEXTURES: usize = 64;
/// The canvas ceiling: Vulkan's guaranteed minimum `maxImageDimension2D`, so a
/// size accepted here is one every conformant device can allocate.
pub const MAX_CANVAS_DIMENSION: u32 = 16384;
/// `TENSION_2D_TEX_RGBA8` — the one target format this build serves.
const TEX_RGBA8: i32 = 1;

/// Which renderer holds the swapchain.
///
/// Two today. `Render2d` is this module; `RenderOgre` is the DSO that still
/// creates its own window unless the host published a surface. The guard exists
/// so the second one to ask gets a Tension-shaped message rather than SDL's
/// generic one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RendererId {
    Render2d,
    RenderOgre,
}

impl RendererId {
    /// The name a refusal names. Short, and the same word the log uses.
    pub fn name(self) -> &'static str {
        match self {
            RendererId::Render2d => "2D",
            RendererId::RenderOgre => "Ogre",
        }
    }
}

/// One open canvas.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Canvas {
    /// The canvas size the guest declared. The offscreen target is this big.
    pub width: u32,
    pub height: u32,
    /// Whether this canvas presents to the host's window.
    pub windowed: bool,
}

/// A loaded texture and the size its pages must agree on.
struct TextureEntry {
    texture: Texture<'static>,
    width: u32,
    height: u32,
}

/// One pipeline's texture array.
///
/// `tex` in the record is a page index, and the fragment stage samples
/// `texture2DArray` at that layer. One array per pipeline, not one texture per
/// draw: splitting a bucket by page would reorder the draws and overrule the
/// graph's sort, which is the one thing a multi-atlas must not do.
///
/// All pages share the array's dimensions, because an array texture has one
/// size. A page of a different size is refused at `set_texture` rather than
/// resampled — resampling would move pixels inside a cell, and the record's src
/// rect is in pixels.
struct Atlas {
    array: Texture<'static>,
    width: u32,
    height: u32,
    /// Pages bound so far. `0` means the pipeline has no explicit atlas and the
    /// implicit one is used.
    pages: u32,
    bound: [u32; MAX_ATLAS_PAGES],
}

/// One draw call's worth of records, all for one pipeline.
struct Bucket {
    pipe_id: u32,
    records: Vec<[u8; RECORD_SIZE as usize]>,
}

/// The 2D renderer's whole state.
///
/// Field order is drop order, and the ordering is load-bearing: the GPU device
/// holds a claim on the host's window, so the device must be gone before the
/// window is. `HostState` declares this field before `host_window` for the same
/// reason.
#[derive(Default)]
pub struct Render2dState {
    // ── the canvas and its GPU objects ────────────────────────────────────
    target: Option<Texture<'static>>,
    sampler: Option<Sampler>,
    /// The array a pipeline samples when it has bound nothing: sixteen 1x1
    /// white pages, so a record that names no atlas still draws its rect.
    default_array: Option<Texture<'static>>,
    /// The array built from the most recently loaded texture, for pipelines that
    /// never call `set_texture` (every v1 caller). Rebuilt when a new texture is
    /// loaded, so `tex = 0` means "the atlas I just loaded".
    implicit_array: Option<Texture<'static>>,
    implicit_source: u32,
    implicit_width: u32,
    implicit_height: u32,
    storage: Option<Buffer>,
    upload: Option<TransferBuffer>,
    download: Option<TransferBuffer>,

    // ── the tables ────────────────────────────────────────────────────────
    pipelines: PipelineCache,
    textures: BTreeMap<u32, TextureEntry>,
    atlases: BTreeMap<u32, Atlas>,
    buckets: BTreeMap<u32, Bucket>,
    /// The texture a pipeline with no explicit pages samples at page 0.
    bound_texture: u32,

    // ── the session ───────────────────────────────────────────────────────
    canvas: Option<Canvas>,
    swapchain_owner: Option<RendererId>,
    presented_once: bool,
    window_closed: bool,
    window_close_reported: bool,

    // Last, so everything above drops first: the device owns every object
    // listed above it, and `sdl3`'s containers release through a weak handle
    // that is only live while this is.
    device: Option<Device>,
    /// The video subsystem, held for as long as the device is.
    ///
    /// Not redundant with `HostWindow`'s: an **offscreen** canvas has no window,
    /// and `SDL_CreateGPUDevice` still needs the video subsystem initialised or
    /// it refuses with "Video subsystem not initialized". SDL refcounts it, so a
    /// second handle beside the window's is free.
    video: Option<sdl3::VideoSubsystem>,
}

impl Render2dState {
    /// The open canvas, if any.
    pub fn canvas(&self) -> Option<Canvas> {
        self.canvas
    }

    /// Who holds the swapchain, if anyone.
    pub fn owner(&self) -> Option<RendererId> {
        self.swapchain_owner
    }

    /// Whether a GPU device is up.
    pub fn has_device(&self) -> bool {
        self.device.is_some()
    }

    /// The canvas width, or 0 when nothing is open.
    pub fn width(&self) -> u32 {
        self.canvas.map(|c| c.width).unwrap_or(0)
    }

    /// The canvas height, or 0 when nothing is open.
    pub fn height(&self) -> u32 {
        self.canvas.map(|c| c.height).unwrap_or(0)
    }

    /// Take the swapchain, or refuse because someone else has it.
    ///
    /// **This is the arbitration the merge was for.** SDL_GPU refuses a second
    /// claim cleanly — `VULKAN_ClaimWindow`, read at release-3.4.18
    /// (`SDL_gpu_vulkan.c:9940-10012`), returns `false` with
    /// `"Window already claimed"` for a different device and refcounts for the
    /// same one, leaving the existing claim untouched either way. That is safe
    /// but not *legible*: the refusal arrives as `-ENODEV` with a string that
    /// reads like "no GPU", which is why core mediates first and SDL stays the
    /// backstop.
    pub fn claim_swapchain(&mut self, who: RendererId) -> Result<(), Render2dError> {
        match self.swapchain_owner {
            Some(held) if held != who => Err(Render2dError::Busy(format!(
                "the swapchain is held by {}; {} cannot present to the same window",
                held.name(),
                who.name()
            ))),
            _ => {
                self.swapchain_owner = Some(who);
                Ok(())
            }
        }
    }

    /// Give the swapchain back. Idempotent, and a no-op for a renderer that does
    /// not hold it.
    pub fn release_swapchain(&mut self, who: RendererId) {
        if self.swapchain_owner == Some(who) {
            self.swapchain_owner = None;
        }
    }

    // ── open / close ──────────────────────────────────────────────────────

    /// Open a canvas that presents to the host's window.
    ///
    /// Creates the window first if there is none: at `width`x`height`, which is
    /// the size the renderer declared. This is the whole of "the host creates
    /// the window on demand" — there is no flag, no startup window, and no
    /// second size to keep in step.
    pub fn open_windowed(
        &mut self,
        host_window: &mut Option<HostWindow>,
        width: u32,
        height: u32,
    ) -> Result<i32, Render2dError> {
        self.validate_open(width, height)?;
        // Refuse before creating anything, so a refusal leaves no window behind
        // for the next caller to trip over.
        self.claim_swapchain(RendererId::Render2d)?;

        if host_window.is_none() {
            let window = HostWindow::new("Tension", width, height).map_err(|error| {
                self.release_swapchain(RendererId::Render2d);
                Render2dError::NoDevice(format!("creating the host window: {error}"))
            })?;
            *host_window = Some(window);
        } else if let Some(window) = host_window.as_ref() {
            let (open_width, open_height) = window.published_size();
            if (open_width, open_height) != (width, height) {
                // Not a refusal: the swapchain scales to the drawable size, so a
                // mismatch shows the same frame larger or smaller rather than a
                // crop. Worth a line because it is the one case where the canvas
                // size and the window size disagree, and the reason is always
                // that `--window` chose first.
                crate::logging::log(
                    crate::logging::Level::Info,
                    "2d",
                    &format!(
                        "open: canvas is {width}x{height}, window is \
                         {open_width}x{open_height} (from --window); presenting scaled"
                    ),
                );
            }
        }

        let window = host_window
            .as_ref()
            .ok_or_else(|| Render2dError::NoDevice("no host window".to_string()))?;

        let video = ensure_video().inspect_err(|_| {
            self.release_swapchain(RendererId::Render2d);
        })?;

        let device = Device::new(ShaderFormat::SPIRV, false).map_err(|error| {
            self.release_swapchain(RendererId::Render2d);
            Render2dError::NoDevice(format!("CreateGPUDevice: {error}"))
        })?;

        // The thread rule: `SDL_ClaimWindowForGPUDevice` must run on the thread
        // that created the window (`SDL_gpu.h:4140-4142`). Every verb runs on
        // the interpreter thread, which is the thread `HostWindow::new` ran on,
        // so the rule holds by construction.
        let device = device.with_window(window.sdl_window()).map_err(|error| {
            self.release_swapchain(RendererId::Render2d);
            Render2dError::NoDevice(format!(
                "ClaimWindowForGPUDevice: {error} — if this reads `Window already \
                 claimed`, another renderer holds it"
            ))
        })?;

        if let Err(error) = device.set_swapchain_parameters(
            window.sdl_window(),
            sdl3::gpu::PresentMode::Vsync,
            sdl3::gpu::SwapchainComposition::Sdr,
        ) {
            // Not fatal: SDL's default composition and present mode are also
            // correct, just not the ones the DSO chose. Say so rather than
            // failing an open over a presentation hint.
            crate::logging::log(
                crate::logging::Level::Warn,
                "2d",
                &format!("open: swapchain parameters refused ({error}); using SDL's defaults"),
            );
        }

        let resources = GpuResources::create(&device, width, height)?;
        self.adopt(device, video, resources, Canvas { width, height, windowed: true });
        Ok(1)
    }

    /// Open a canvas that presents nowhere.
    ///
    /// No window, no claim, no swapchain: `screenshot` reads the target back and
    /// that is the only way to see the frame. This is what every headless run
    /// and every pixel assertion in CI uses, and it is why a 2D-only headless
    /// run never creates a window at all.
    pub fn open_offscreen(&mut self, width: u32, height: u32) -> Result<i32, Render2dError> {
        self.validate_open(width, height)?;
        let video = ensure_video()?;
        let device = Device::new(ShaderFormat::SPIRV, false)
            .map_err(|error| Render2dError::NoDevice(format!("CreateGPUDevice: {error}")))?;
        let resources = GpuResources::create(&device, width, height)?;
        self.adopt(device, video, resources, Canvas { width, height, windowed: false });
        Ok(1)
    }

    fn validate_open(&self, width: u32, height: u32) -> Result<(), Render2dError> {
        if self.canvas.is_some() {
            return Err(Render2dError::Busy(
                "a canvas is already open; one at a time".to_string(),
            ));
        }
        if width == 0 || height == 0 || width > MAX_CANVAS_DIMENSION || height > MAX_CANVAS_DIMENSION
        {
            return Err(Render2dError::Invalid(format!(
                "open: canvas outside 1..{MAX_CANVAS_DIMENSION}"
            )));
        }
        Ok(())
    }

    fn adopt(
        &mut self,
        device: Device,
        video: sdl3::VideoSubsystem,
        resources: GpuResources,
        canvas: Canvas,
    ) {
        self.target = Some(resources.target);
        self.sampler = Some(resources.sampler);
        self.default_array = Some(resources.default_array);
        self.storage = Some(resources.storage);
        self.upload = Some(resources.upload);
        self.device = Some(device);
        self.video = Some(video);
        self.canvas = Some(canvas);
    }

    /// Close the canvas: release the claim, destroy the device, keep the window.
    ///
    /// The window staying up is deliberate and temporary. Destroying it here
    /// would need a lifecycle that answers "what if the guest reopens?" — and a
    /// guest that closes its canvas has finished drawing, so the window is
    /// already idle. Pass C takes the decision; this pass leaves the window to
    /// process exit, where `main` already drops it after the adapters.
    pub fn close(&mut self, handle: i32) -> Result<i32, Render2dError> {
        let canvas = self
            .canvas
            .ok_or_else(|| Render2dError::Invalid("close: no canvas is open".to_string()))?;
        if handle != 1 {
            return Err(Render2dError::Invalid(format!(
                "close: handle {handle} is not the open canvas"
            )));
        }
        if canvas.windowed {
            self.release_swapchain(RendererId::Render2d);
        }
        // Explicit, in declaration order, rather than relying on `Drop` alone:
        // a texture dropped after the device is a silent leak in `sdl3`'s
        // weak-handle scheme rather than a fault, and a leak that only shows up
        // when nothing is logged.
        self.target = None;
        self.sampler = None;
        self.default_array = None;
        self.implicit_array = None;
        self.implicit_source = 0;
        self.implicit_width = 1;
        self.implicit_height = 1;
        self.storage = None;
        self.upload = None;
        self.download = None;
        self.pipelines = PipelineCache::new();
        self.textures.clear();
        self.atlases.clear();
        self.buckets.clear();
        self.bound_texture = 0;
        self.presented_once = false;
        self.window_closed = false;
        self.window_close_reported = false;
        // Dropping the device is what releases SDL's window claim: `sdl3` 0.22
        // has no `SDL_ReleaseWindowFromGPUDevice` binding, and SDL releases every
        // claim a device holds when the device goes.
        self.device = None;
        self.video = None;
        self.canvas = None;
        Ok(0)
    }

    fn device(&self) -> Result<&Device, Render2dError> {
        self.device
            .as_ref()
            .ok_or_else(|| Render2dError::NoDevice("no canvas is open".to_string()))
    }

    // ── set_pipeline ──────────────────────────────────────────────────────

    /// Resolve a built-in preset id (`blob_len < 100`, the DSO's encoding).
    pub fn set_preset(&mut self, preset: u16) -> Result<u32, Render2dError> {
        let device = self.device()?.clone();
        self.pipelines.preset(&device, preset)
    }

    /// Resolve a guest's graph blob to a pipeline id.
    ///
    /// The DSO's `-ENOSYS`-then-`compile_graph` dance is gone: the compiler is
    /// in this process, so this is parse → validate → lower → compile → build,
    /// in one call, with the compiler's own errno on failure.
    pub fn set_pipeline_blob(&mut self, blob: &[u8]) -> Result<u32, Render2dError> {
        let device = self.device()?.clone();
        self.pipelines.blob(&device, blob)
    }

    /// Whether a blob hash is one the build ships artifacts for.
    pub fn has_builtin_graph(&self, hash: u64) -> bool {
        crate::render2d::pipeline::builtin_pipe_id(hash).is_some()
    }

    // ── submit ────────────────────────────────────────────────────────────

    /// Append records to a bucket.
    ///
    /// The adapter has already copied the guest's bytes — the renderer never
    /// sees a guest pointer, which is what makes the staging copy safe to sort
    /// and re-sort.
    pub fn submit(
        &mut self,
        pipe_id: u32,
        records: &[u8],
        count: u32,
        stride: u32,
        bucket: u32,
    ) -> Result<u32, Render2dError> {
        if self.device.is_none() {
            return Err(Render2dError::NoDevice("no canvas is open".to_string()));
        }
        if !self.pipelines.contains(pipe_id) {
            return Err(Render2dError::NotFound(format!(
                "submit: unknown pipe_id {pipe_id}"
            )));
        }
        if records.is_empty() || count == 0 {
            return Err(Render2dError::Invalid("submit: empty submission".to_string()));
        }
        if stride != RECORD_SIZE {
            return Err(Render2dError::Invalid(
                "submit: record_stride disagrees with the layout".to_string(),
            ));
        }
        if bucket >= MAX_BUCKETS {
            return Err(Render2dError::Invalid(
                "submit: bucket index outside 0..7".to_string(),
            ));
        }

        let staged: usize = self.buckets.values().map(|b| b.records.len()).sum();
        if staged + count as usize > MAX_RECORDS {
            return Err(Render2dError::Full(format!(
                "submit: staging buffer full ({MAX_RECORDS} records)"
            )));
        }

        if let Some(existing) = self.buckets.get(&bucket) {
            if existing.pipe_id != pipe_id {
                // A bucket is one draw call, so it is one pipeline. Two pipes in
                // one bucket is not a merge this adapter will guess at.
                return Err(Render2dError::Invalid(format!(
                    "submit: bucket {bucket} already belongs to pipe {}",
                    existing.pipe_id
                )));
            }
        }

        let slot = self.buckets.entry(bucket).or_insert_with(|| Bucket {
            pipe_id,
            records: Vec::new(),
        });
        slot.pipe_id = pipe_id;
        for i in 0..count as usize {
            let start = i * stride as usize;
            let mut record = [0u8; RECORD_SIZE as usize];
            record.copy_from_slice(&records[start..start + RECORD_SIZE as usize]);
            slot.records.push(record);
        }
        Ok(count)
    }

    // ── present ───────────────────────────────────────────────────────────

    /// Draw every bucket recorded since the last call, then clear the staging
    /// state.
    pub fn present(&mut self, host_window: &mut Option<HostWindow>) -> Result<i32, Render2dError> {
        let Render2dState {
            device,
            target,
            sampler,
            default_array,
            implicit_array,
            implicit_source,
            implicit_width,
            implicit_height,
            storage,
            upload,
            pipelines,
            atlases,
            buckets,
            bound_texture,
            canvas,
            presented_once,
            window_closed,
            window_close_reported,
            ..
        } = self;

        let device = device
            .as_ref()
            .ok_or_else(|| Render2dError::NoDevice("no canvas is open".to_string()))?;
        let canvas = canvas
            .as_ref()
            .ok_or_else(|| Render2dError::NoDevice("no canvas is open".to_string()))?;

        // Gather every bucket in ascending order, so the buckets are contiguous
        // in one storage-buffer upload and differ only by first_instance.
        // `BTreeMap` iteration is the `std::map` order the C++ used.
        struct Span {
            first: usize,
            count: usize,
            pipe_id: u32,
        }
        let mut frame: Vec<[u8; RECORD_SIZE as usize]> = Vec::new();
        let mut spans: Vec<Span> = Vec::new();
        for bucket in buckets.values_mut() {
            // Ordered by the graph's key list, so the built-in preset and a
            // compiled graph sort identically. `sort_by` is stable, which is
            // what makes a frame reproducible: equal keys keep submission order.
            bucket
                .records
                .sort_by(|a, b| record::compare(a, b));
            spans.push(Span {
                first: frame.len(),
                count: bucket.records.len(),
                pipe_id: bucket.pipe_id,
            });
            frame.extend_from_slice(&bucket.records);
        }

        // Resolve every span's atlas before recording: creating one submits a
        // copy of its own, and a command buffer is cleaner to acquire outside
        // the frame's.
        for span in &spans {
            if atlases.contains_key(&span.pipe_id) {
                continue;
            }
            // No explicit pages: the pipeline samples the most recently loaded
            // texture at page 0. That is the v1 behaviour every caller had
            // before `set_texture` existed, kept so `tex = 0` still means "my
            // atlas".
            if *bound_texture == 0 {
                continue;
            }
            if implicit_array.is_some() && *implicit_source == *bound_texture {
                continue;
            }
            let Some(source) = self.textures.get(bound_texture) else {
                continue;
            };
            let (source_width, source_height) = (source.width, source.height);
            let source_texture = source.texture.clone();
            // Replace rather than release-then-create: assigning `None` first
            // drops the old array, and the borrow of `self.textures` above has
            // to end before that.
            *implicit_array = None;
            let array = create_array(device, source_width, source_height)?;
            copy_into_layer(
                device,
                &source_texture,
                &array,
                0,
                source_width,
                source_height,
            )?;
            *implicit_array = Some(array);
            *implicit_width = source_width;
            *implicit_height = source_height;
            *implicit_source = *bound_texture;
        }

        let command = device
            .acquire_command_buffer()
            .map_err(|error| Render2dError::Io(format!("AcquireGPUCommandBuffer: {error}")))?;

        if !frame.is_empty() {
            let bytes = frame.len() * RECORD_SIZE as usize;
            let upload_buffer = upload.as_ref().ok_or_else(|| {
                Render2dError::Io("AcquireGPUCommandBuffer: no upload buffer".to_string())
            })?;
            {
                let mut map = upload_buffer.map::<u8>(device, true);
                let memory = map.mem_mut();
                // Flatten the record array into the transfer buffer in one copy.
                for (index, record) in frame.iter().enumerate() {
                    let start = index * RECORD_SIZE as usize;
                    memory[start..start + RECORD_SIZE as usize].copy_from_slice(record);
                }
                map.unmap();
            }

            let storage_buffer = storage.as_ref().ok_or_else(|| {
                Render2dError::Io("AcquireGPUCommandBuffer: no storage buffer".to_string())
            })?;
            let copy = device
                .begin_copy_pass(&command)
                .map_err(|error| Render2dError::Io(format!("BeginGPUCopyPass: {error}")))?;
            copy.upload_to_gpu_buffer(
                sdl3::gpu::TransferBufferLocation::new()
                    .with_transfer_buffer(upload_buffer)
                    .with_offset(0),
                sdl3::gpu::BufferRegion::new()
                    .with_buffer(storage_buffer)
                    .with_offset(0)
                    .with_size(bytes as u32),
                true,
            );
            device.end_copy_pass(copy);
        }

        // A present with nothing submitted re-presents the frame already in the
        // target. That is what makes a windowed handle usable: the guest draws
        // once, then loops on `present` to keep the window up, and an empty
        // present that cleared to black would flash the screen instead of
        // holding the image. The first present on a handle always draws, so
        // there is never a "stale frame from a previous handle" to inherit.
        let repaint = frame.is_empty() && *presented_once;

        if !repaint {
            let target_texture = target
                .as_ref()
                .ok_or_else(|| Render2dError::NoDevice("no render target".to_string()))?;
            let color_target = sdl3::gpu::ColorTargetInfo::default()
                .with_texture(target_texture)
                .with_clear_color(Color::RGBA(0, 0, 0, 255))
                .with_load_op(LoadOp::CLEAR)
                .with_store_op(StoreOp::STORE);
            let pass = device
                .begin_render_pass(&command, &[color_target], None)
                .map_err(|error| Render2dError::Io(format!("BeginGPURenderPass: {error}")))?;

            if !frame.is_empty() {
                // One pipeline per span: buckets may belong to different pipes,
                // and a pipeline bound for the wrong span draws the wrong
                // shader.
                let mut bound_pipe = 0u32;
                if let Some(storage_buffer) = storage.as_ref() {
                    pass.bind_vertex_storage_buffers(0, std::slice::from_ref(storage_buffer));
                }

                for span in &spans {
                    if span.count == 0 {
                        continue;
                    }
                    let Some(pipeline) = pipelines.get(span.pipe_id) else {
                        continue;
                    };
                    if span.pipe_id != bound_pipe {
                        pass.bind_graphics_pipeline(pipeline);
                        bound_pipe = span.pipe_id;
                    }

                    // The atlas is per pipeline, so the uniform and the sampler
                    // binding move with the span rather than being set once per
                    // frame. The block is `{ vec2 u_canvas_half; vec2
                    // u_tex_size }`: the canvas projects pixels to clip, the
                    // page size normalizes the record's pixel src rect before
                    // sampling.
                    let mut atlas: Option<&Texture<'static>> = None;
                    let mut tex_w = 1.0f32;
                    let mut tex_h = 1.0f32;
                    if let Some(explicit) = atlases.get(&span.pipe_id) {
                        if explicit.pages > 0 {
                            atlas = Some(&explicit.array);
                            tex_w = explicit.width as f32;
                            tex_h = explicit.height as f32;
                        }
                    }
                    if atlas.is_none() {
                        if let Some(implicit) = implicit_array.as_ref() {
                            atlas = Some(implicit);
                            tex_w = *implicit_width as f32;
                            tex_h = *implicit_height as f32;
                        }
                    }
                    let atlas = atlas
                        .or(default_array.as_ref())
                        .ok_or_else(|| Render2dError::NoDevice("no atlas".to_string()))?;

                    let uniforms = [
                        canvas.width as f32 * 0.5,
                        canvas.height as f32 * 0.5,
                        tex_w,
                        tex_h,
                    ];
                    command.push_vertex_uniform_data(0, &uniforms);

                    if let Some(sampler) = sampler.as_ref() {
                        pass.bind_fragment_samplers(
                            0,
                            &[sdl3::gpu::TextureSamplerBinding::new()
                                .with_texture(atlas)
                                .with_sampler(sampler)],
                        );
                    }

                    pass.draw_primitives(6, span.count, 0, span.first);
                }
            }

            device.end_render_pass(pass);
        }

        // Presentation. The frame was drawn into `target`; a windowed handle
        // copies it into the swapchain image as well. A blit rather than a
        // second render pass because the target and the swapchain may differ in
        // format, and `SDL_BlitGPUTexture` is the one call that handles a format
        // change without a pipeline per format.
        if let Some(window) = host_window.as_mut() {
            // Pump before acquiring: a closed window has no swapchain, and
            // asking for one would be an error every frame after the user
            // quits. `HostWindow::pump` is the same call the host loop makes,
            // on the same thread — this is the DSO's `SDL_PollEvent` loop with
            // the host's own bookkeeping around it.
            let events = window.pump();
            if events.close_requested {
                *window_closed = true;
            }

            if !*window_closed {
                match command.wait_and_acquire_swapchain_texture(window.sdl_window()) {
                    Ok(Some(swapchain)) => {
                        let source = target.as_ref().ok_or_else(|| {
                            Render2dError::NoDevice("no render target".to_string())
                        })?;
                        command.blit_texture(
                            sdl3::gpu::BlitInfo::default()
                                .with_source_texture(source)
                                .with_source_region(0, 0, 0, canvas.width, canvas.height)
                                .with_destination_texture(&swapchain)
                                .with_destination_region(
                                    0,
                                    0,
                                    0,
                                    swapchain.width(),
                                    swapchain.height(),
                                )
                                .with_load_op(LoadOp::DONT_CARE)
                                .with_filter(Filter::Nearest),
                        );
                    }
                    Ok(None) => {
                        // A null swapchain is legal: the window may be minimised
                        // or otherwise unable to present this frame. The frame
                        // is still drawn; it just is not shown.
                    }
                    Err(error) => {
                        return Err(Render2dError::Io(format!(
                            "AcquireGPUSwapchainTexture: {error}"
                        )));
                    }
                }
            }
        }

        command
            .submit()
            .map_err(|error| Render2dError::Io(format!("SubmitGPUCommandBuffer: {error}")))?;
        wait_for_gpu_idle(device)?;

        buckets.clear();
        *presented_once = true;

        // One clear message when the user closes the window, rather than a
        // failure per frame afterwards. The guest's next verb sees a normal
        // return; the frame simply stops appearing.
        if *window_closed && !*window_close_reported {
            *window_close_reported = true;
            return Err(Render2dError::Canceled(
                "present: the window was closed".to_string(),
            ));
        }
        Ok(0)
    }

    // ── textures ──────────────────────────────────────────────────────────

    /// Decode and upload one texture.
    pub fn texture_load(
        &mut self,
        source: &[u8],
        target_format: i32,
    ) -> Result<u32, Render2dError> {
        let device = self.device()?.clone();
        if target_format != TEX_RGBA8 {
            // The other three formats exist in the wire (`tension_2d.h`) and
            // need a conversion this build cannot do: it holds decoded RGBA8
            // only.
            return Err(Render2dError::Unsupported(
                "texture_load: only RGBA8 targets are served at v1".to_string(),
            ));
        }
        if self.textures.len() >= MAX_TEXTURES {
            return Err(Render2dError::Full(
                "texture_load: texture table full".to_string(),
            ));
        }

        let image = decode_iwi(source)?;
        let texture = upload_rgba(&device, &image.rgba, image.width, image.height)?;

        let id = self.textures.len() as u32 + 1;
        self.textures.insert(
            id,
            TextureEntry {
                texture,
                width: image.width,
                height: image.height,
            },
        );
        // The most recently loaded texture is the one a pipeline with no
        // explicit `set_texture` pages samples at page 0 — the single-atlas
        // behaviour every v1 caller relies on. Explicit page binding is
        // `set_texture`.
        self.bound_texture = id;
        Ok(id)
    }

    /// Bind a loaded texture to one page of a pipeline's texture array.
    pub fn set_texture(
        &mut self,
        pipe_id: u32,
        slot: u32,
        texture_id: u32,
    ) -> Result<i32, Render2dError> {
        let device = self.device()?.clone();
        if !self.pipelines.contains(pipe_id) {
            return Err(Render2dError::NotFound(format!(
                "set_texture: unknown pipe_id {pipe_id}"
            )));
        }
        if slot as usize >= MAX_ATLAS_PAGES {
            return Err(Render2dError::Invalid(format!(
                "set_texture: page {slot} outside 0..{}",
                MAX_ATLAS_PAGES - 1
            )));
        }
        let Some(texture) = self.textures.get(&texture_id) else {
            return Err(Render2dError::NotFound(format!(
                "set_texture: unknown texture id {texture_id}"
            )));
        };
        let (texture_width, texture_height) = (texture.width, texture.height);
        let texture_handle = texture.texture.clone();

        if let std::collections::btree_map::Entry::Vacant(slot) = self.atlases.entry(pipe_id) {
            // An array texture has one size for every page. The first page
            // bound to a pipeline fixes it; a page of another size is refused
            // rather than resampled, because resampling moves pixels inside a
            // cell and the record's src rect is in pixels.
            let array = create_array(&device, texture_width, texture_height)?;
            slot.insert(Atlas {
                array,
                width: texture_width,
                height: texture_height,
                pages: 0,
                bound: [0; MAX_ATLAS_PAGES],
            });
        }

        let atlas = self
            .atlases
            .get_mut(&pipe_id)
            .ok_or_else(|| Render2dError::Io("set_texture: atlas vanished".to_string()))?;
        if atlas.width != texture_width || atlas.height != texture_height {
            return Err(Render2dError::Invalid(format!(
                "set_texture: texture {texture_id} is {texture_width}x{texture_height}, the \
                 pipeline's atlas is {}x{} — every page of one pipeline shares the array's size",
                atlas.width, atlas.height
            )));
        }

        if atlas.bound[slot as usize] != texture_id {
            copy_into_layer(
                &device,
                &texture_handle,
                &atlas.array,
                slot,
                atlas.width,
                atlas.height,
            )?;
            atlas.bound[slot as usize] = texture_id;
        }
        if atlas.pages == 0 {
            atlas.pages = 1;
        }
        Ok(0)
    }

    // ── info / screenshot ─────────────────────────────────────────────────

    /// The `info` record this handle would write.
    pub fn info(&self) -> Result<InfoRecord, Render2dError> {
        let canvas = self
            .canvas
            .ok_or_else(|| Render2dError::NoDevice("no canvas is open".to_string()))?;
        Ok(InfoRecord {
            version: 2,
            max_records: MAX_RECORDS as u16,
            max_textures: MAX_TEXTURES as u32,
            max_pipelines: crate::render2d::pipeline::MAX_PIPELINES as u32,
            max_buckets: MAX_BUCKETS as u16,
            flags: 0,
            canvas_width: canvas.width,
            canvas_height: canvas.height,
        })
    }

    /// Copy the last presented frame out as RGBA8.
    pub fn screenshot(&mut self) -> Result<Vec<u8>, Render2dError> {
        let device = self.device()?.clone();
        let canvas = self
            .canvas
            .ok_or_else(|| Render2dError::NoDevice("no canvas is open".to_string()))?;
        if !self.presented_once {
            return Err(Render2dError::NoDevice(
                "screenshot: nothing has been presented".to_string(),
            ));
        }

        let bytes = canvas.width as usize * canvas.height as usize * 4;
        if self.download.is_none() {
            let buffer = device
                .create_transfer_buffer()
                .with_usage(TransferBufferUsage::DOWNLOAD)
                .with_size(bytes as u32)
                .build()
                .map_err(|error| {
                    Render2dError::NoMemory(format!("CreateGPUTransferBuffer(download): {error}"))
                })?;
            self.download = Some(buffer);
        }
        let download = self
            .download
            .as_ref()
            .ok_or_else(|| Render2dError::NoMemory("no download buffer".to_string()))?;
        let target = self
            .target
            .as_ref()
            .ok_or_else(|| Render2dError::NoDevice("no render target".to_string()))?;

        let command = device
            .acquire_command_buffer()
            .map_err(|error| Render2dError::Io(format!("AcquireGPUCommandBuffer: {error}")))?;
        download_texture(
            &device,
            &command,
            target,
            download,
            canvas.width,
            canvas.height,
        )?;
        command
            .submit()
            .map_err(|error| Render2dError::Io(format!("SubmitGPUCommandBuffer: {error}")))?;
        wait_for_gpu_idle(&device)?;

        let mut out = vec![0u8; bytes];
        let map = download.map::<u8>(&device, false);
        out.copy_from_slice(&map.mem()[..bytes]);
        map.unmap();
        Ok(out)
    }
}

/// The GPU objects one open canvas owns, built together so a partial failure
/// releases what it made.
struct GpuResources {
    target: Texture<'static>,
    sampler: Sampler,
    default_array: Texture<'static>,
    storage: Buffer,
    upload: TransferBuffer,
}

impl GpuResources {
    fn create(device: &Device, width: u32, height: u32) -> Result<Self, Render2dError> {
        // The target: the canvas, as a colour target.
        let target = create_texture(
            device,
            width,
            height,
            TextureUsage::COLOR_TARGET,
            TextureType::_2D,
            1,
        )
        .map_err(|error| Render2dError::NoMemory(format!("CreateGPUTexture(target): {error}")))?;

        let sampler = device
            .create_sampler(
                sdl3::gpu::SamplerCreateInfo::new()
                    .with_min_filter(Filter::Nearest)
                    .with_mag_filter(Filter::Nearest)
                    .with_mipmap_mode(SamplerMipmapMode::Nearest)
                    .with_address_mode_u(SamplerAddressMode::ClampToEdge)
                    .with_address_mode_v(SamplerAddressMode::ClampToEdge)
                    .with_address_mode_w(SamplerAddressMode::ClampToEdge),
            )
            .map_err(|error| Render2dError::Io(format!("CreateGPUSampler: {error}")))?;

        // The array a bucket binds when it has none: sixteen 1x1 opaque white
        // pages, so a record that names no atlas still draws its rect — and a
        // record that names page 7 gets a defined texel rather than whatever the
        // driver left in an unwritten layer.
        let default_array = {
            let white = upload_rgba(device, &[255, 255, 255, 255], 1, 1)?;
            let array = create_array(device, 1, 1)
                .map_err(|error| Render2dError::NoMemory(format!("CreateGPUTexture: {error}")))?;
            for layer in 0..MAX_ATLAS_PAGES as u32 {
                copy_into_layer(device, &white, &array, layer, 1, 1)?;
            }
            array
        };

        let buffer_bytes = (MAX_RECORDS * RECORD_SIZE as usize) as u32;
        let storage = device
            .create_buffer()
            .with_usage(BufferUsageFlags::GRAPHICS_STORAGE_READ)
            .with_size(buffer_bytes)
            .build()
            .map_err(|error| Render2dError::NoMemory(format!("CreateGPUBuffer(storage): {error}")))?;

        let upload = device
            .create_transfer_buffer()
            .with_usage(TransferBufferUsage::UPLOAD)
            .with_size(buffer_bytes)
            .build()
            .map_err(|error| {
                Render2dError::NoMemory(format!("CreateGPUTransferBuffer(storage): {error}"))
            })?;

        Ok(GpuResources {
            target,
            sampler,
            default_array,
            storage,
            upload,
        })
    }
}

/// A `width`x`height` RGBA8 texture with one layer and one level.
///
/// The format is fixed at `R8G8B8A8_UNORM` because that is what the pipeline's
/// colour target declares and what `screenshot` promises.
fn create_texture(
    device: &Device,
    width: u32,
    height: u32,
    usage: TextureUsage,
    kind: TextureType,
    layers: u32,
) -> Result<Texture<'static>, String> {
    device
        .create_texture(
            TextureCreateInfo::new()
                .with_type(kind)
                .with_format(TextureFormat::R8g8b8a8Unorm)
                .with_usage(usage)
                .with_width(width)
                .with_height(height)
                .with_layer_count_or_depth(layers)
                .with_num_levels(1)
                .with_sample_count(SampleCount::NoMultiSampling),
        )
        .map_err(|error| error.to_string())
}

/// A texture array of [`MAX_ATLAS_PAGES`] layers at one size.
///
/// Every page is the same dimensions because an array texture has one size;
/// `set_texture` refuses a page that disagrees instead of resampling it.
fn create_array(
    device: &Device,
    width: u32,
    height: u32,
) -> Result<Texture<'static>, Render2dError> {
    create_texture(
        device,
        width,
        height,
        TextureUsage::SAMPLER,
        TextureType::_2DArray,
        MAX_ATLAS_PAGES as u32,
    )
    .map_err(|error| Render2dError::NoMemory(format!("CreateGPUTexture(array): {error}")))
}

/// Upload a tightly packed RGBA8 raster.
///
/// The transfer buffer is created per call: textures load rarely, and a shared
/// one would need size tracking this path does not earn.
fn upload_rgba(
    device: &Device,
    rgba: &[u8],
    width: u32,
    height: u32,
) -> Result<Texture<'static>, Render2dError> {
    let bytes = (width as usize)
        .checked_mul(height as usize)
        .and_then(|px| px.checked_mul(4))
        .ok_or_else(|| Render2dError::Invalid("texture: size overflow".to_string()))?;
    if rgba.len() < bytes {
        return Err(Render2dError::Invalid(
            "texture: raster is shorter than its dimensions".to_string(),
        ));
    }

    let transfer = device
        .create_transfer_buffer()
        .with_usage(TransferBufferUsage::UPLOAD)
        .with_size(bytes as u32)
        .build()
        .map_err(|error| {
            Render2dError::NoMemory(format!("CreateGPUTransferBuffer(upload): {error}"))
        })?;

    let texture = create_texture(
        device,
        width,
        height,
        TextureUsage::SAMPLER,
        TextureType::_2D,
        1,
    )
    .map_err(|error| Render2dError::NoMemory(format!("CreateGPUTexture: {error}")))?;

    {
        let mut map = transfer.map::<u8>(device, false);
        map.mem_mut()[..bytes].copy_from_slice(&rgba[..bytes]);
        map.unmap();
    }

    let command = device
        .acquire_command_buffer()
        .map_err(|error| Render2dError::Io(format!("AcquireGPUCommandBuffer: {error}")))?;
    let copy = device
        .begin_copy_pass(&command)
        .map_err(|error| Render2dError::Io(format!("BeginGPUCopyPass: {error}")))?;
    copy.upload_to_gpu_texture(
        sdl3::gpu::TextureTransferInfo::new()
            .with_transfer_buffer(&transfer)
            .with_offset(0)
            .with_pixels_per_row(width)
            .with_rows_per_layer(height),
        sdl3::gpu::TextureRegion::new()
            .with_texture(&texture)
            .with_width(width)
            .with_height(height)
            .with_depth(1),
        true,
    );
    device.end_copy_pass(copy);
    command
        .submit()
        .map_err(|error| Render2dError::Io(format!("SubmitGPUCommandBuffer(upload): {error}")))?;

    Ok(texture)
}

/// Copy one 2D texture into one layer of an array.
///
/// A GPU-side copy: the pixels are never read back to the CPU, which is why a
/// [`TextureEntry`] does not retain them.
///
/// **Why this is `unsafe`.** `sdl3` 0.22 binds `SDL_UploadToGPUTexture` and
/// `SDL_BlitGPUTexture` but not `SDL_CopyGPUTextureToTexture`, which lives only
/// in the generated `sdl3-sys` layer. Rather than add a second binding crate or
/// reimplement the copy with a per-layer blit (different semantics: blit
/// resamples, copy does not), this calls the sys function through the handle
/// `sdl3` already owns.
fn copy_into_layer(
    device: &Device,
    source: &Texture<'_>,
    destination: &Texture<'_>,
    layer: u32,
    width: u32,
    height: u32,
) -> Result<(), Render2dError> {
    use sdl3::sys::gpu as sysgpu;

    let command = device
        .acquire_command_buffer()
        .map_err(|error| Render2dError::Io(format!("AcquireGPUCommandBuffer(copy): {error}")))?;

    let source_location = sysgpu::SDL_GPUTextureLocation {
        texture: source.raw(),
        mip_level: 0,
        layer: 0,
        x: 0,
        y: 0,
        z: 0,
    };
    let destination_location = sysgpu::SDL_GPUTextureLocation {
        texture: destination.raw(),
        mip_level: 0,
        layer,
        x: 0,
        y: 0,
        z: 0,
    };

    // SAFETY: both texture handles come from `sdl3`'s owning `Texture`, which
    // keeps them alive for this call; the command buffer is live and no copy
    // pass is open on it; the two location structs are stack locals that outlive
    // the call. `cycle = false` overwrites the destination layer, which is what
    // a fresh page bind wants.
    let submitted = unsafe {
        let pass = sysgpu::SDL_BeginGPUCopyPass(command.raw());
        if pass.is_null() {
            false
        } else {
            sysgpu::SDL_CopyGPUTextureToTexture(
                pass,
                &source_location,
                &destination_location,
                width,
                height,
                1,
                false,
            );
            sysgpu::SDL_EndGPUCopyPass(pass);
            command.submit().is_ok()
        }
    };

    if !submitted {
        return Err(Render2dError::Io(
            "SubmitGPUCommandBuffer(copy): the layer copy did not complete".to_string(),
        ));
    }
    Ok(())
}

/// Read the target back into a download transfer buffer.
///
/// **Why this is `unsafe`:** `SDL_DownloadFromGPUTexture` is not in the `sdl3`
/// crate either, for the same reason as the layer copy above.
fn download_texture(
    device: &Device,
    command: &sdl3::gpu::CommandBuffer,
    target: &Texture<'_>,
    download: &TransferBuffer,
    width: u32,
    height: u32,
) -> Result<(), Render2dError> {
    use sdl3::sys::gpu as sysgpu;

    let region = sysgpu::SDL_GPUTextureRegion {
        texture: target.raw(),
        mip_level: 0,
        layer: 0,
        x: 0,
        y: 0,
        z: 0,
        w: width,
        h: height,
        d: 1,
    };
    let info = sysgpu::SDL_GPUTextureTransferInfo {
        transfer_buffer: download.raw(),
        offset: 0,
        pixels_per_row: width,
        rows_per_layer: height,
    };

    // SAFETY: the texture and transfer buffer are owned by `sdl3` handles alive
    // for this call; the command buffer is live and holds no open pass; both
    // descriptors are stack locals that outlive the call. The download is
    // ordered before the fence the caller waits on, so the bytes are ready when
    // this returns — the wait is `wait_for_gpu_idle` in the caller.
    let opened = unsafe {
        let pass = sysgpu::SDL_BeginGPUCopyPass(command.raw());
        if pass.is_null() {
            false
        } else {
            sysgpu::SDL_DownloadFromGPUTexture(pass, &region, &info);
            sysgpu::SDL_EndGPUCopyPass(pass);
            true
        }
    };
    if !opened {
        let _ = device;
        return Err(Render2dError::Io(
            "BeginGPUCopyPass(download) refused".to_string(),
        ));
    }
    Ok(())
}

/// Block until the device has finished everything submitted.
///
/// `sdl3` 0.22 has `wait_fences`, which waits on fences you acquired, not on the
/// device as a whole. Both the C++ readback and its frame submit used
/// `SDL_WaitForGPUIdle`, and the parity harness depends on the same
/// synchronisation point existing, so this is the sys call rather than a
/// fence-based approximation that would wait for less.
fn wait_for_gpu_idle(device: &Device) -> Result<(), Render2dError> {
    // SAFETY: the device handle is alive for this call. `SDL_WaitForGPUIdle`
    // takes no other arguments and does not retain the pointer.
    let ok = unsafe { sdl3::sys::gpu::SDL_WaitForGPUIdle(device.raw()) };
    if ok {
        Ok(())
    } else {
        Err(Render2dError::Io("WaitForGPUIdle refused".to_string()))
    }
}

/// Bring up SDL's video subsystem, or say which step refused.
///
/// `sdl3::init()` is refcounted and thread-checked: a second call on the same
/// thread is fine, a call from another thread is refused by the crate. Every
/// caller here runs on the interpreter thread.
fn ensure_video() -> Result<sdl3::VideoSubsystem, Render2dError> {
    let sdl = sdl3::init().map_err(|error| {
        Render2dError::NoDevice(format!("SDL_Init: {error}"))
    })?;
    let video = sdl.video().map_err(|error| {
        Render2dError::NoDevice(format!("SDL_InitSubSystem(VIDEO): {error}"))
    })?;

    // `dummy` is a video driver with no GPU backend: `SDL_CreateGPUDevice` fails
    // against it with "No supported SDL_GPU backend found!", which reads as
    // "this machine has no GPU" when the real answer is "this driver has no
    // GPU". A headless run that sets it out of habit — SDL's own docs suggest it
    // for headless — then spends an afternoon on the wrong question. Refuse
    // here, by name, before the device is attempted.
    //
    // The errno is unchanged: this is the same `-ENODEV` the device-creation
    // failure would have produced, arrived at one step earlier and reported
    // honestly. `offscreen` is the driver that does have a GPU backend.
    //
    // Ported from `render.cpp:491-505`. It is easy to lose in a port because it
    // is a *diagnostic* rather than a mechanism — nothing depends on it except
    // a reader's afternoon — which is exactly why it has its own probe case in
    // `tests/render2d_open.rs`.
    if video.current_video_driver() == "dummy" {
        return Err(Render2dError::NoDevice(
            "open: SDL_VIDEODRIVER=dummy has no GPU backend — use offscreen for a headless run"
                .to_string(),
        ));
    }
    Ok(video)
}

/// Kept so a caller that only has a `PlatformError` can name its errno.
pub fn platform_errno(error: &crate::platform::PlatformError) -> i32 {
    Render2dError::NoDevice(error.to_string()).errno()
}
