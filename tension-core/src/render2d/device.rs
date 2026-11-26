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

use std::collections::{BTreeMap, BTreeSet};

use sdl3::gpu::{
    Buffer, BufferUsageFlags, Device, Filter, LoadOp, Sampler, SamplerAddressMode,
    SamplerMipmapMode, SampleCount, ShaderFormat, StoreOp, Texture, TextureCreateInfo,
    TextureFormat, TextureType, TextureUsage, TransferBuffer, TransferBufferUsage,
};
use sdl3::pixels::Color;

use crate::platform::HostWindow;
use crate::render2d::error::Render2dError;
use crate::render2d::iwi::decode_iwi;
use crate::render2d::pipeline::{PipelineCache, PIPE_PRESET_MAX, PIPE_PRESET_MIN};
use crate::render2d::record::{self, InfoRecord, RECORD_SIZE};

/// `TENSION_2D_MAX_ATLAS_PAGES` — the layer count of a pipeline's texture array.
pub const MAX_ATLAS_PAGES: usize = 16;

/// The first page a nested guest's atlases land on, in the outer device's array.
///
/// **Measured, not chosen for symmetry.** The outer guest is the one that owns
/// the window and draws its own content into the same window, and the editor
/// binds its own generated atlas at page 0 of its game pipeline
/// (`apps/editor/src/main.ten`). Play mode hides chrome; it does not re-bind or
/// rebuild that pipeline, so page 0 has to keep holding what it held before the
/// nested guest started. So the nested guest gets `1..16`.
///
/// The demand side, also measured: `box-physics` binds 1 page, `isometric` binds
/// 3 (its three painted islands), the editor's own atlas is 1. Fifteen pages is
/// four times the largest of those; the number is a floor for the outer, not a
/// ceiling for the nested guest.
pub const NESTED_PAGE_BASE: u32 = 1;

/// The outer device's page for a nested guest's page — `base + page`, checked.
///
/// A page arithmetic that is not enforced at the boundary fails at frame 400,
/// when a guest finally loads its sixteenth atlas, not at frame 1 where the
/// mistake was made. So the bound is here, in one function every replay and every
/// forwarded record goes through, and not in a comment beside a `+`.
pub fn nested_page(page_base: u32, page: u32) -> Result<u32, Render2dError> {
    match page_base.checked_add(page) {
        Some(both) if (both as usize) < MAX_ATLAS_PAGES => Ok(both),
        _ => Err(Render2dError::Invalid(format!(
            "page arithmetic: nested page {page} at base {page_base} exceeds the \
             {MAX_ATLAS_PAGES}-page array"
        ))),
    }
}
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

/// How a [`Render2dState`] relates to a GPU.
///
/// **`Capture` is preparation, and it is inert until the record path lands.**
/// Nothing constructs a capture state yet: the nested guest that will hold one
/// is Pass 2's, and the host verb that copies its records out is a later slice.
/// The mode exists now because *where* the frame is cleared decides whether a
/// nested guest's records can be read at all, and that decision belongs to the
/// state rather than to the caller.
///
/// The two modes differ in exactly three places, and nowhere else:
///
/// * `open_offscreen` — `Capture` records the canvas and creates no GPU device,
///   so a guest that can never present still gets a handle.
/// * `submit` — `Capture` does not require a device or a compiled pipeline,
///   because neither can exist without one; the record's `pipe_id` is carried
///   through for the host to resolve against its own device.
/// * `present` — `Capture` leaves the staged records in place. In the presenting
///   mode the staging is scratch, consumed by the draw; to a capturing host it
///   *is* the frame, and clearing it there would throw the frame away one call
///   after it was built.
///
/// **The set is open, not closed.** A third variant (working name `Render`) is
/// reserved for the buffer-rendering path, where the inner guest draws into its
/// own offscreen target on the shared device and the outer guest binds that as a
/// texture page. That path is not implemented here and has its own backlog entry;
/// the note is here so a later slice *adds* a variant instead of re-deciding what
/// `present` means.
#[derive(Default, Clone, Copy, PartialEq, Eq, Debug)]
pub enum Mode {
    /// The ordinary canvas: a device, a target, draws, and a present.
    #[default]
    Present,
    /// Staging only: records accumulate and stay, and nothing is drawn.
    Capture,
}

/// The 2D renderer's whole state.
///
/// Field order is drop order, and the ordering is load-bearing: the GPU device
/// holds a claim on the host's window, so the device must be gone before the
/// window is. `HostState` declares this field before `host_window` for the same
/// The GPU work a **capture** state recorded instead of performing.
///
/// A capture state has no device (the device belongs to the outer guest), so
/// every verb that would build a GPU object instead **reserves its id and
/// records what to build**. The records the guest submits then carry ids that
/// are already correct *within this run*, which is what lets the same record
/// bytes be replayed against the outer device later: the replay allocates the
/// GPU objects, and the ids it hands back are the ones the records already name.
///
/// Empty in `Present` mode, where the work is done rather than recorded.
pub struct Deferred {
    /// Texture id -> the IWI the guest handed to `texture_load`, and its target
    /// format. The bytes are kept **undecoded** as well as validated: a replay
    /// on another device loads them through the same path `texture_load` uses,
    /// so anything the decode would reject is rejected by both.
    pub textures: BTreeMap<u32, (Vec<u8>, i32)>,
    /// Pipeline id -> what it was made from.
    pub pipelines: BTreeMap<u32, DeferredPipeline>,
    /// Blob hash -> id, so a guest that re-sets the same graph gets the same id,
    /// exactly as `PipelineCache::by_blob` gives it in a present state.
    pub by_blob: BTreeMap<u64, u32>,
    /// `(pipe_id, slot, texture_id)` in call order — `set_texture`, recorded.
    pub bindings: Vec<(u32, u32, u32)>,
    /// The next id for a runtime-compiled graph, from
    /// [`crate::render2d::pipeline::PIPE_RAW_MIN`].
    pub next_pipe: u32,
}

impl Default for Deferred {
    fn default() -> Self {
        Self {
            textures: BTreeMap::new(),
            pipelines: BTreeMap::new(),
            by_blob: BTreeMap::new(),
            bindings: Vec::new(),
            // Not 0: an id below `PIPE_RAW_MIN` is a preset id in this ABI, and
            // a compiled graph claiming one would collide with a preset.
            next_pipe: crate::render2d::pipeline::PIPE_RAW_MIN,
        }
    }
}

/// What a deferred pipeline was built from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DeferredPipeline {
    /// A built-in preset (`set_pipeline` with `blob_len < 100`).
    Preset(u16),
    /// A guest's graph blob, kept byte for byte so the replay compiles the same
    /// graph rather than a re-hash of it.
    Blob(Vec<u8>),
}

/// What [`Render2dState::replay_deferred`] did, in the outer device's ids.
///
/// **The pipeline ids are new, and the caller must use them.** A nested guest's
/// pipeline is a second object with its own texture array — the outer's preset 1
/// and the nested guest's preset 1 hold different atlases, and an array has one
/// size — so the replay builds it fresh rather than resolving the id the capture
/// used. A caller that submits a forwarded frame under the *nested* id instead of
/// the mapped one draws through the outer's pipeline, with the outer's atlas.
///
/// Textures map the same way: the replay loads the recorded bytes through the
/// presenter's own `texture_load`, and the id that answers is the one the drawing
/// device issued.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Replay {
    /// Nested pipeline id -> the id on this device.
    pub pipelines: BTreeMap<u32, u32>,
    /// Nested texture id -> the id on this device.
    pub textures: BTreeMap<u32, u32>,
    /// `(pipeline id on this device, page, texture id on this device)`, in the
    /// order they were bound — the recorded bindings first, then any implicit
    /// page the replay had to make explicit.
    pub pages: Vec<(u32, u32, u32)>,
}

/// reason.
#[derive(Default)]
pub struct Render2dState {
    /// How this state relates to a GPU. `Present` for every existing caller;
    /// see [`Mode`] for what `Capture` changes and why it is not exercised yet.
    mode: Mode,

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
    /// What a capture state recorded instead of building. Empty in `Present`.
    deferred: Deferred,

    // ── the session ───────────────────────────────────────────────────────
    canvas: Option<Canvas>,
    /// The records of the last frame a capture state completed, in bucket order.
    ///
    /// A snapshot taken at `present`, so the staging buckets can start the next
    /// frame empty while the host still reads a whole frame.
    captured: Vec<u8>,
    /// How many frames a **capture** state has been asked to present.
    ///
    /// The frame-complete signal for a nested guest: `dev.frame` drives the guest
    /// and returns only once this has advanced, so a mid-frame yield (a
    /// `session_wait`, an AI completion) cannot hand the host a half-built frame.
    /// Unused in `Present` mode, where `buckets.clear()` is the same information.
    captured_frames: u32,
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
    /// A state that stages records and never draws.
    ///
    /// No device, no window, no video subsystem: this is what a nested guest's
    /// renderer is, because the guest that owns the window is the outer one.
    /// The records it stages are the host's to read, which is why
    /// [`Render2dState::present`] keeps them in this mode.
    pub fn capture() -> Self {
        Self {
            mode: Mode::Capture,
            ..Self::default()
        }
    }

    /// Frames this capture state has presented. The frame-complete signal.
    pub fn captured_frames(&self) -> u32 {
        self.captured_frames
    }

    /// Bytes of staged records, across every bucket, in bucket order.
    ///
    /// The frame as a nested guest built it. `dev.read` copies this; nothing here
    /// sorts, because sorting is the presenter's job (`present` orders by the
    /// graph's keys) and a capture state never presents.
    pub fn captured_bytes(&self) -> usize {
        self.captured.len()
    }

    /// Copy the staged records into `out`, returning how many bytes were written.
    ///
    /// Writes nothing and returns the length when `out` is too small — the
    /// caller checks first (`captured_bytes`), and a partial copy here would be
    /// the truncation the whole-frame rule forbids.
    pub fn capture_into(&self, out: &mut [u8]) -> usize {
        let need = self.captured_bytes();
        if out.len() < need {
            return 0;
        }
        out[..need].copy_from_slice(&self.captured);
        need
    }

    /// Copy the staged records into `out` with each record's page moved to the
    /// outer device's numbering.
    ///
    /// [`Self::capture_into`] is the frame *as the guest built it* — the bytes a
    /// test inspects or a log quotes. This is the same frame *as the outer device
    /// will draw it*, and it is what `dev.read` hands the outer guest: that guest
    /// submits the bytes to a device on which pages `0..page_base` already hold
    /// its own atlases, so a nested record still naming page 0 would draw the
    /// wrong texture.
    ///
    /// An error rather than a truncated copy, for the reason `submit` refuses a
    /// frame it cannot hold: half a frame looks like a renderer bug.
    pub fn forward_into(&self, out: &mut [u8], page_base: u32) -> Result<usize, Render2dError> {
        // `nested_page` decides whether the base is legal; the cast is safe after
        // it, because a legal base is below `MAX_ATLAS_PAGES`.
        nested_page(page_base, 0)?;
        let base = page_base as u16;
        let need = self.captured_bytes();
        if out.len() < need {
            return Err(Render2dError::Full(format!(
                "forward: {} bytes of records do not fit in {} — whole frame or nothing",
                need,
                out.len()
            )));
        }
        // Refuse before writing: the caller's buffer is left as it was, so a
        // refused frame cannot be mistaken for a truncated one.
        if let Some(page) = record::unfit_page(&self.captured, base, MAX_ATLAS_PAGES as u16) {
            return Err(Render2dError::Invalid(format!(
                "forward: nested page {page} at base {base} exceeds the \
                 {MAX_ATLAS_PAGES}-page array"
            )));
        }
        out[..need].copy_from_slice(&self.captured);
        record::offset_pages(&mut out[..need], base, MAX_ATLAS_PAGES as u16);
        Ok(need)
    }

    /// What this capture state recorded, for the host that will replay it.
    pub fn deferred(&self) -> &Deferred {
        &self.deferred
    }

    /// Build what a nested guest recorded on **this** device, and bind its pages.
    ///
    /// This is the other half of [`Render2dState::capture`]. A capture state
    /// reserved ids for objects it could not build; this one builds them, in the
    /// order the capture handed the ids out (ascending, which is the guest's call
    /// order), and reports the ids the device actually gave them — the caller
    /// submits the forwarded records with those.
    ///
    /// **Pages move by `page_base`.** A nested guest's page 0 is not the outer
    /// device's page 0: the outer guest draws its own content through the same
    /// pipeline array, so it keeps `0..page_base` and the nested guest gets
    /// `page_base..MAX_ATLAS_PAGES`. Records are moved by
    /// [`Render2dState::forward_into`], bindings here, both through
    /// [`nested_page`] so the bound is enforced once.
    ///
    /// **The outer's implicit page 0 survives.** A presenting state's page 0 of
    /// a pipeline with no explicit atlas means "the last texture the outer
    /// loaded". Binding a nested texture to such a pipeline would make the
    /// array explicit and drop that meaning, so the outer's own implicit
    /// texture is bound to page 0 first — the same texture, now written down.
    /// A pipeline the outer already bound explicitly is left alone.
    ///
    /// **The outer's implicit *source* is restored.** `texture_load` sets
    /// `bound_texture` as a side effect; replaying a nested texture must not
    /// change which texture the outer's own unbound pipelines sample.
    pub fn replay_deferred(
        &mut self,
        deferred: &Deferred,
        page_base: u32,
    ) -> Result<Replay, Render2dError> {
        if self.is_capture() {
            return Err(Render2dError::Invalid(
                "replay: this state captures; replay onto the canvas that draws".to_string(),
            ));
        }
        // The base itself has to be a page, before anything is built: a base of
        // 16 would build a whole deferred scene and then fail on its first bind.
        nested_page(page_base, 0)?;
        self.device()?;

        let mut replay = Replay::default();

        // 1. Pipelines, ascending id: the order the capture resolved them in, so
        //    the ids it reports stay in that order.
        //
        //    **Each one is a new object, never the pipeline of the same id this
        //    device already holds.** A pipeline owns one texture array and an
        //    array has one size, so a nested guest whose atlas differs from the
        //    outer's (the editor's font pages are 640x500, the isometric scene's
        //    128x128) cannot share the array: reusing preset 1 would refuse every
        //    page of the nested frame with `-EINVAL`. Ownership is the whole
        //    point of the replay, and it is why the ids it hands back are new —
        //    the caller asks for them (`Replay::pipelines`) rather than assuming.
        let device = self.device()?.clone();
        for (recorded, what) in &deferred.pipelines {
            let built = match what {
                DeferredPipeline::Preset(preset) => self.pipelines.fresh_preset(&device, *preset)?,
                DeferredPipeline::Blob(blob) => self.pipelines.fresh_blob(&device, blob)?,
            };
            replay.pipelines.insert(*recorded, built);
        }

        // 2. Textures, ascending id — the capture assigned them in load order,
        //    so ascending is "the order the guest loaded them", and the last one
        //    is the implicit page-0 source.
        let outer_implicit = self.bound_texture;
        for (recorded, (bytes, format)) in &deferred.textures {
            let id = self.texture_load(bytes, *format)?;
            replay.textures.insert(*recorded, id);
        }
        self.bound_texture = outer_implicit;

        // 3. The pages to bind. Recorded bindings first, in call order — the
        //    order matters only for the atlas's size, which the first page fixes.
        let mut wanted: Vec<(u32, u32, u32)> = Vec::with_capacity(deferred.bindings.len());
        for (pipe, slot, texture) in &deferred.bindings {
            let Some(outer_pipe) = replay.pipelines.get(pipe).copied() else {
                return Err(Render2dError::NotFound(format!(
                    "replay: binding names pipeline {pipe}, which was never recorded"
                )));
            };
            let Some(outer_texture) = replay.textures.get(texture).copied() else {
                return Err(Render2dError::NotFound(format!(
                    "replay: binding names texture {texture}, which was never recorded"
                )));
            };
            wanted.push((outer_pipe, nested_page(page_base, *slot)?, outer_texture));
        }

        // The implicit page. A nested guest that never called `set_texture`
        // samples "the atlas I just loaded" at page 0 — in a capture state as in
        // a presenting one. Reapplied at `page_base` for every pipeline the frame
        // uses that has no recorded binding, because that is what the presenting
        // path would have done one page lower.
        let implicit = deferred
            .textures
            .keys()
            .next_back()
            .and_then(|id| replay.textures.get(id))
            .copied();
        if let Some(implicit) = implicit {
            let bound: BTreeSet<u32> = wanted.iter().map(|(pipe, _, _)| *pipe).collect();
            for outer_pipe in replay.pipelines.values() {
                if !bound.contains(outer_pipe) {
                    wanted.push((*outer_pipe, nested_page(page_base, 0)?, implicit));
                }
            }
        }

        // 4. Bind, preserving the outer's page 0 on the first touch of a pipeline
        //    it draws through implicitly.
        //
        //    **Only when the sizes agree.** An array texture has one size for all
        //    its pages, so an outer implicit texture that is a different size
        //    cannot be page 0 of this array at all — `set_texture` would refuse it,
        //    and the refusal would take the whole nested frame with it. Skipping is
        //    the honest answer: the two never shared this pipeline, which is the
        //    normal case (the editor's own content is on its graph pipe, the nested
        //    guest's on a preset), and it is visible in the log when it is not.
        let mut touched: BTreeSet<u32> = BTreeSet::new();
        for (outer_pipe, page, outer_texture) in wanted {
            if touched.insert(outer_pipe)
                && !self.atlases.contains_key(&outer_pipe)
                && self.bound_texture != 0
            {
                let outer_zero = self.bound_texture;
                let same_size = match (self.textures.get(&outer_zero), self.textures.get(&outer_texture))
                {
                    (Some(outer), Some(nested)) => {
                        outer.width == nested.width && outer.height == nested.height
                    }
                    _ => false,
                };
                if same_size {
                    self.set_texture(outer_pipe, 0, outer_zero)?;
                } else if let (Some(outer), Some(nested)) =
                    (self.textures.get(&outer_zero), self.textures.get(&outer_texture))
                {
                    crate::logging::log(
                        crate::logging::Level::Warn,
                        "2d",
                        &format!(
                            "replay: pipeline {outer_pipe} keeps no outer page 0 — the outer's \
                             texture is {}x{} and the nested page is {}x{}, and one array has one \
                             size",
                            outer.width, outer.height, nested.width, nested.height
                        ),
                    );
                }
            }
            self.set_texture(outer_pipe, page, outer_texture)?;
            replay.pages.push((outer_pipe, page, outer_texture));
        }
        Ok(replay)
    }

    /// Which mode this state is in.
    pub fn mode(&self) -> Mode {
        self.mode
    }

    /// Whether this state stages instead of drawing.
    pub fn is_capture(&self) -> bool {
        self.mode == Mode::Capture
    }

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
        shared: &std::sync::Arc<crate::platform::HostShared>,
    ) -> Result<i32, Render2dError> {
        if self.is_capture() {
            // A capture canvas cannot own the window: the window and its device
            // are the outer guest's, and this state exists so the inner one can
            // draw without touching either. Refused rather than silently
            // treated as offscreen, because a guest that asked for a window and
            // got one invisibly is a bug that would surface as "nothing is
            // drawn" three layers away. Whether `open(windowed)` inside a
            // nested guest should *become* an offscreen capture canvas is a
            // decision for the slice that maps a guest's flags onto capture
            // mode, not for this one.
            return Err(Render2dError::Unsupported(
                "open: a capture canvas cannot own the window".to_string(),
            ));
        }
        self.validate_open(width, height)?;
        // Refuse before creating anything, so a refusal leaves no window behind
        // for the next caller to trip over.
        self.claim_swapchain(RendererId::Render2d)?;

        if host_window.is_none() {
            // The same path a guest takes, so there is one window-creation
            // implementation rather than two that drift: `create_window` with
            // `target: Gpu`, which is what makes SDL_GPU able to claim it and
            // what keeps `SDL_WINDOW_VULKAN` off a window no Vulkan surface
            // will be built from.
            let config = crate::platform::WindowConfig {
                target: crate::platform::WindowTarget::Gpu,
                width,
                height,
                title: "Tension".to_string(),
                ..Default::default()
            };
            crate::platform::create_window(host_window, &config, shared).map_err(|error| {
                self.release_swapchain(RendererId::Render2d);
                Render2dError::NoDevice(format!("creating the host window: {error}"))
            })?;
        } else if let Some(window) = host_window.as_ref() {
            let (open_width, open_height) = window.published_size();
            if (open_width, open_height) != (width, height) {
                // Not a refusal: the swapchain scales to the drawable size, so a
                // mismatch shows the same frame larger or smaller rather than a
                // crop. Worth a line because it is the one case where the canvas
                // size and the window size disagree, and the reason is always
                // that the guest created the window first.
                crate::logging::log(
                    crate::logging::Level::Info,
                    "2d",
                    &format!(
                        "open: canvas is {width}x{height}, window is \
                         {open_width}x{open_height} (created by the guest); presenting scaled"
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
        if self.is_capture() {
            // A capture canvas is a rectangle and a handle, nothing else. The
            // guest that draws into it is nested, and a second GPU device in
            // this process would be a second presenter for one window — the
            // singleton list in `host/mod.rs` exists to forbid exactly that.
            self.canvas = Some(Canvas { width, height, windowed: false });
            return Ok(1);
        }
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
        self.captured_frames = 0;
        self.captured.clear();
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
        if self.is_capture() {
            // Same validation the present path applies, then record instead of
            // build. A capture state cannot check that the preset exists in this
            // build beyond `1`, and it does not need to: the replay builds it and
            // reports there, with the run's id already in the guest's records.
            if !(PIPE_PRESET_MIN..=PIPE_PRESET_MAX).contains(&preset) {
                return Err(Render2dError::NotFound(
                    "set_pipeline: preset id outside 1..99".to_string(),
                ));
            }
            let id = u32::from(preset);
            self.deferred
                .pipelines
                .entry(id)
                .or_insert(DeferredPipeline::Preset(preset));
            return Ok(id);
        }
        let device = self.device()?.clone();
        self.pipelines.preset(&device, preset)
    }

    /// Resolve a guest's graph blob to a pipeline id.
    ///
    /// The DSO's `-ENOSYS`-then-`compile_graph` dance is gone: the compiler is
    /// in this process, so this is parse → validate → lower → compile → build,
    /// in one call, with the compiler's own errno on failure.
    pub fn set_pipeline_blob(&mut self, blob: &[u8]) -> Result<u32, Render2dError> {
        if self.is_capture() {
            if blob.is_empty() {
                return Err(Render2dError::Invalid(
                    "set_pipeline: empty blob".to_string(),
                ));
            }
            // The same three cases the present path resolves, minus the build:
            // already recorded, a graph the build ships (pinned id), or a new
            // runtime id. Keeping the order means a guest sees the same ids in
            // either mode, which is what makes the record bytes replayable.
            let hash = crate::render2d::pipeline::graph_hash(blob);
            if let Some(id) = self.deferred.by_blob.get(&hash) {
                return Ok(*id);
            }
            let id = match crate::render2d::pipeline::builtin_pipe_id(hash) {
                Some(pinned) => pinned,
                None => {
                    let id = self.deferred.next_pipe;
                    self.deferred.next_pipe += 1;
                    id
                }
            };
            self.deferred.by_blob.insert(hash, id);
            self.deferred
                .pipelines
                .insert(id, DeferredPipeline::Blob(blob.to_vec()));
            return Ok(id);
        }
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
        // In capture mode there is no device by construction (`open_offscreen`
        // makes none), so neither of the two device-dependent checks below can
        // hold. A capture stage carries the guest's `pipe_id` through untouched
        // and the host resolves it against the device that actually draws —
        // which is the only device in the process.
        if !self.is_capture() {
            if self.device.is_none() {
                return Err(Render2dError::NoDevice("no canvas is open".to_string()));
            }
            if !self.pipelines.contains(pipe_id) {
                return Err(Render2dError::NotFound(format!(
                    "submit: unknown pipe_id {pipe_id}"
                )));
            }
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
    ///
    /// In [`Mode::Capture`] this draws nothing and **snapshots** the frame: the
    /// staged records are copied into `captured` and the staging buckets are
    /// cleared, so the next frame starts empty exactly as it does in a
    /// presenting state. Clearing is what makes a long-run guest possible at
    /// all — staged records that were never cleared accumulated across frames
    /// and hit the bucket capacity after ~89 frames of a 46-node scene
    /// (measured: `submit failed on frame 89` on `examples/2d/box-physics`).
    ///
    /// The capacity rule above `submit` — the whole frame is refused rather
    /// than truncated — applies in both modes, so a capture that overflows
    /// fails the same way a presenting frame does.
    pub fn present(&mut self, host_window: &mut Option<HostWindow>) -> Result<i32, Render2dError> {
        if self.is_capture() {
            // **A repaint keeps the frame.** A presenting state re-presents what
            // is already in its target when nothing was submitted, which is what
            // lets a guest draw once and then loop on `present` to hold the
            // window. A capture state has no target, so its equivalent is to
            // keep the snapshot it already took: clearing there would hand the
            // host an empty frame one call after a complete one, and a nested
            // guest written for a window (draw once, present to hold) would go
            // blank inside the editor for a reason nothing in its code says.
            if self.buckets.is_empty() && !self.captured.is_empty() {
                self.captured_frames = self.captured_frames.wrapping_add(1);
                return Ok(0);
            }
            // Snapshot, then clear: the frame the host will read is the one just
            // completed, and the buckets are ready for the next one.
            self.captured.clear();
            let need: usize = self.buckets.values().map(|b| b.records.len()).sum::<usize>()
                * RECORD_SIZE as usize;
            self.captured.reserve(need);
            for bucket in self.buckets.values() {
                for record in &bucket.records {
                    self.captured
                        .extend_from_slice(&record[..RECORD_SIZE as usize]);
                }
            }
            self.buckets.clear();
            self.captured_frames = self.captured_frames.wrapping_add(1);
            return Ok(0);
        }
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
        // The format check comes before the device, and the device only where it
        // is used: a capture state has none, and asking for one first would make
        // every `texture_load` in a sandbox `-ENODEV` regardless of the bytes.
        if target_format != TEX_RGBA8 {
            // The other three formats exist in the wire (`tension_2d.h`) and
            // need a conversion this build cannot do: it holds decoded RGBA8
            // only.
            return Err(Render2dError::Unsupported(
                "texture_load: only RGBA8 targets are served at v1".to_string(),
            ));
        }
        if self.textures.len().max(self.deferred.textures.len()) >= MAX_TEXTURES {
            return Err(Render2dError::Full(
                "texture_load: texture table full".to_string(),
            ));
        }

        // **Capture mode records the load.** The IWI is still decoded here, so a
        // texture this build cannot serve is refused in a sandbox exactly as it
        // is in the presenter — the refusal path exists before the replay path,
        // which is the point of doing it now rather than in 4b-6. The bytes are
        // kept undecoded for the replay to load through this same function on
        // the outer device.
        if self.is_capture() {
            decode_iwi(source)?;
            let id = self.deferred.textures.len() as u32 + 1;
            self.deferred
                .textures
                .insert(id, (source.to_vec(), target_format));
            self.bound_texture = id;
            return Ok(id);
        }

        let device = self.device()?.clone();
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
        // Capture mode records the binding against the ids it issued: the
        // pipeline and texture both exist there as deferred entries, not as GPU
        // objects, so the same three refusals have to be answered from those.
        if self.is_capture() {
            if !self.deferred.pipelines.contains_key(&pipe_id) {
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
            if !self.deferred.textures.contains_key(&texture_id) {
                return Err(Render2dError::NotFound(format!(
                    "set_texture: unknown texture id {texture_id}"
                )));
            }
            self.deferred.bindings.push((pipe_id, slot, texture_id));
            return Ok(0);
        }
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

#[cfg(test)]
mod capture_tests {
    //! Capture mode's verbs, with no device to fall back on.
    //!
    //! Every assertion here would be an `-ENODEV` if the capture branch were
    //! missing, which is exactly the failure this mode exists to avoid: a nested
    //! guest has no GPU, and a verb that reaches for one gives it nothing to draw
    //! with.

    use super::*;

    #[test]
    fn a_capture_state_resolves_pipelines_without_a_device() {
        let mut state = Render2dState::capture();
        // A preset keeps its own id, as it does when built.
        assert_eq!(state.set_preset(1).expect("preset 1 resolves"), 1);
        // An out-of-range preset is refused, not silently given an id.
        assert!(state.set_preset(0).is_err());
        assert!(state.set_preset(200).is_err());

        // A graph blob gets a runtime id from `PIPE_RAW_MIN`, and the same blob
        // twice gets the same id — the dedupe a present state does by hash.
        let blob = b"not a real graph, but a stable one".to_vec();
        let first = state.set_pipeline_blob(&blob).expect("a blob resolves");
        assert!(first >= crate::render2d::pipeline::PIPE_RAW_MIN, "got {first}");
        assert_eq!(state.set_pipeline_blob(&blob).expect("again"), first);

        // Recorded, so the host can replay it.
        assert!(matches!(
            state.deferred().pipelines.get(&first),
            Some(DeferredPipeline::Blob(b)) if *b == blob
        ));
    }

    #[test]
    fn a_capture_state_refuses_a_texture_it_could_not_serve() {
        let mut state = Render2dState::capture();
        // Not an IWI: the same refusal the presenting path gives, answered here
        // without a device — which is the point of doing it before 4b-6.
        assert!(
            state.texture_load(b"definitely not an IWI container", 0).is_err(),
            "a non-IWI texture is refused in capture mode too"
        );
        // And the table is not polluted by the refusal.
        assert_eq!(state.deferred().textures.len(), 0);
    }

    #[test]
    fn a_capture_state_records_a_texture_it_could_serve() {
        // The **positive** half of the pair above, and the one 4b-5 replays
        // against. The negative test proves a non-container is refused; on its
        // own it would let a capture state that refuses *everything* pass, and
        // 4b-5 would then be built on a proof that only says "broken bytes are
        // rejected".
        let mut state = Render2dState::capture();
        let bytes = crate::render2d::iwi::iwi_bytes(2, 1, 4, &[1, 2, 3, 4, 5, 6, 7, 8]);

        let id = state
            .texture_load(&bytes, TEX_RGBA8)
            .expect("a valid IWI loads in capture mode");
        assert_eq!(id, 1, "the first texture gets id 1");

        // The bytes are kept **byte for byte**, undecoded, because the replay
        // hands them to the outer device's own `texture_load`: a copy that
        // normalized them here would be a second decoder with no test.
        let (recorded, format) = state
            .deferred()
            .textures
            .get(&id)
            .expect("the texture is recorded for the replay");
        assert_eq!(recorded, &bytes, "the recorded bytes are the guest's bytes");
        assert_eq!(*format, TEX_RGBA8);

        // And the binding is recorded against the page the guest named, at the
        // index the guest named — not at 0 by default. 4b-5 offsets a record's
        // `tex` by the nested guest's page base, so a slot recorded one place
        // and applied one page earlier would draw the atlas from the wrong page.
        let pipe = state.set_pipeline_blob(b"a graph for the binding").expect("a blob");
        assert_eq!(state.set_texture(pipe, 2, id).expect("bind page 2"), 0);
        let recorded = state.deferred().bindings.last().expect("a binding");
        assert_eq!(*recorded, (pipe, 2, id));
    }

    #[test]
    fn a_capture_state_validates_bindings_against_what_it_recorded() {
        let mut state = Render2dState::capture();
        let pipe = state.set_pipeline_blob(b"another graph").expect("a blob");
        // No texture has been loaded, so there is nothing to bind.
        assert!(state.set_texture(pipe, 0, 1).is_err());
        // An unknown pipeline is refused by id.
        assert!(state.set_texture(9999, 0, 1).is_err());
        // A page beyond the cap is refused before any lookup.
        assert!(state.set_texture(pipe, MAX_ATLAS_PAGES as u32, 1).is_err());
        assert!(state.deferred().bindings.is_empty());
    }

    #[test]
    fn a_capture_repaint_keeps_the_frame() {
        // A presenting state re-presents its target when nothing was submitted;
        // a capture state's equivalent is keeping the snapshot. Without this, a
        // nested guest written the way every windowed 2D guest is written (draw
        // once, present to hold) hands its host an empty frame one call after a
        // complete one.
        let mut state = Render2dState::capture();
        let mut record = [0u8; RECORD_SIZE as usize];
        record[record::OFF_TEX..record::OFF_TEX + 2].copy_from_slice(&1u16.to_le_bytes());
        state
            .submit(1, &record, 1, RECORD_SIZE, 0)
            .expect("a capture state stages records for any pipe");
        state.present(&mut None).expect("the frame completes");
        assert_eq!(state.captured_bytes(), RECORD_SIZE as usize);
        assert_eq!(state.captured_frames(), 1);

        // A repaint: no records staged, and the frame the host already has is
        // still there to read.
        state.present(&mut None).expect("a repaint completes a frame");
        assert_eq!(
            state.captured_bytes(),
            RECORD_SIZE as usize,
            "a present with nothing staged must not erase the captured frame"
        );
        assert_eq!(state.captured_frames(), 2, "and it is still a completed frame");
    }

    /// `nested_record_tex_is_offset_by_the_page_base`.
    ///
    /// The frame leaves a capture state as the guest built it (page numbers the
    /// guest chose) and reaches the outer guest with the outer device's page
    /// numbers. Both halves are asserted on the same frame, because a forward
    /// that returned the input unchanged would pass an assertion made on only one
    /// of them.
    #[test]
    fn nested_record_tex_is_offset_by_the_page_base() {
        let mut state = Render2dState::capture();
        let mut records = [0u8; 2 * RECORD_SIZE as usize];
        records[record::OFF_TEX..record::OFF_TEX + 2].copy_from_slice(&0u16.to_le_bytes());
        let second = RECORD_SIZE as usize + record::OFF_TEX;
        records[second..second + 2].copy_from_slice(&3u16.to_le_bytes());
        state
            .submit(1, &records, 2, RECORD_SIZE, 0)
            .expect("a capture state stages records for any pipe");
        state.present(&mut None).expect("capture presents");

        let mut raw = vec![0u8; state.captured_bytes()];
        state.capture_into(&mut raw);
        assert_eq!(record::record_page(&raw[..28]), Some(0), "as the guest built it");
        assert_eq!(record::record_page(&raw[28..]), Some(3), "as the guest built it");

        let mut moved = vec![0u8; state.captured_bytes()];
        state
            .forward_into(&mut moved, NESTED_PAGE_BASE)
            .expect("base 1 fits");
        assert_eq!(record::record_page(&moved[..28]), Some(1), "0 moved to the base");
        assert_eq!(record::record_page(&moved[28..]), Some(4), "3 moved by the base");

        // The bound is enforced at the boundary, not clamped: page 3 at base 13
        // is 16, one past the last layer of the array. The buffer is left alone,
        // because the caller submits a frame whole or not at all.
        let mut too_far = vec![0u8; state.captured_bytes()];
        let error = state
            .forward_into(&mut too_far, MAX_ATLAS_PAGES as u32 - 3)
            .expect_err("16 is not a page");
        assert_eq!(error.errno(), crate::render2d::error::EINVAL);
        assert!(
            too_far.iter().all(|byte| *byte == 0),
            "a refused forward writes nothing"
        );
    }

    /// The page base is a checked constant, not a comment beside a `+`.
    #[test]
    fn the_page_base_is_checked_at_the_boundary() {
        assert_eq!(nested_page(0, 0), Ok(0));
        assert_eq!(nested_page(NESTED_PAGE_BASE, 0), Ok(1));
        assert_eq!(nested_page(NESTED_PAGE_BASE, MAX_ATLAS_PAGES as u32 - 2), Ok(15));
        // One past the last layer, at the base itself and at the top page.
        assert!(nested_page(MAX_ATLAS_PAGES as u32, 0).is_err());
        assert!(nested_page(NESTED_PAGE_BASE, MAX_ATLAS_PAGES as u32 - 1).is_err());
        // And a u16 page cannot wrap the base into a legal value.
        assert!(nested_page(NESTED_PAGE_BASE, u32::MAX).is_err());
    }
}

#[cfg(test)]
mod replay_tests {
    //! The nested guest's frame, on the device that actually draws.
    //!
    //! 4b-4 taught a capture state to *record* GPU work instead of performing
    //! it. These are the tests for the other half — `replay_deferred` builds
    //! what was recorded, [`Render2dState::forward_into`] moves a record's page
    //! to the outer device's numbering, and the pixels prove the two agree.
    //!
    //! # Why the three GPU tests take a lock
    //!
    //! `sdl3::init()` declares main-thread status once per process and refuses
    //! every later thread (`sdl3-0.22.0/src/sdl3/sdl.rs:71-84`), and `cargo
    //! test` runs each `#[test]` on its own thread. The declaration is released
    //! when the last `Sdl` handle drops (`:219`), so the tests serialize on
    //! [`SDL`] and each drops its canvas before releasing — one dev
    //! initialization at a time rather than one `harness = false` binary, so
    //! the three claims keep their own names.
    //!
    //! A machine with no GPU skips: the refusal has to *name* the device
    //! (`NoDevice`), and anything else fails. Same policy as
    //! `tests/render2d_open.rs`, same one skip flag.

    use super::*;
    use std::sync::Mutex;

    /// Serializes SDL initialization. See the module comment.
    static SDL: Mutex<()> = Mutex::new(());

    /// A solid-colour 8x8 IWI — the canvas's own size, so a record whose `w`/`h`
    /// are the canvas maps the whole texture and every pixel of the frame is
    /// one colour.
    fn solid(color: [u8; 4]) -> Vec<u8> {
        let mut pixels = Vec::with_capacity(8 * 8 * 4);
        for _ in 0..8 * 8 {
            pixels.extend_from_slice(&color);
        }
        crate::render2d::iwi::iwi_bytes(8, 8, 4, &pixels)
    }

    /// A full-canvas sprite on one page of one pipeline.
    fn sprite(page: u16) -> [u8; RECORD_SIZE as usize] {
        let mut record = [0u8; RECORD_SIZE as usize];
        // x, y are already 0 — the canvas's top-left.
        record[record::OFF_W..record::OFF_W + 2].copy_from_slice(&8u16.to_le_bytes());
        record[record::OFF_H..record::OFF_H + 2].copy_from_slice(&8u16.to_le_bytes());
        record[record::OFF_TEX..record::OFF_TEX + 2].copy_from_slice(&page.to_le_bytes());
        // A non-zero key, so the record is not equal to an empty one under the
        // graph's ordering.
        record[record::OFF_SORT_KEY..record::OFF_SORT_KEY + 4]
            .copy_from_slice(&1u32.to_le_bytes());
        record
    }

    /// An offscreen 8x8 canvas with preset 1 built, or a printed skip.
    fn canvas() -> Option<Render2dState> {
        let mut state = Render2dState::default();
        if let Err(error) = state.open_offscreen(8, 8) {
            match error {
                Render2dError::NoDevice(message) => {
                    eprintln!("skipped: no usable GPU device here: {message}");
                    return None;
                }
                other => panic!("open_offscreen: {other}"),
            }
        }
        state.set_preset(1).expect("preset 1");
        Some(state)
    }

    /// Every pixel of the last presented frame, or a panic naming the first that
    /// differs.
    fn frame_is(state: &mut Render2dState, color: [u8; 4], what: &str) {
        let frame = state.screenshot().expect("screenshot");
        if let Some(first) = frame.chunks_exact(4).position(|px| px != color) {
            panic!(
                "{what}: pixel {first} is {:?}, want {color:?} — the frame did not draw the \
                 texture that page holds",
                &frame[first * 4..first * 4 + 4]
            );
        }
    }

    /// A capture state that loaded one texture, bound it at page 0 of preset 1 if
    /// `bind` is set, and presented one full-canvas record naming page 0.
    fn nested(bind: bool) -> Render2dState {
        let mut capture = Render2dState::capture();
        let pipe = capture.set_preset(1).expect("preset 1 in capture mode");
        let texture = capture
            .texture_load(&solid([255, 0, 0, 255]), TEX_RGBA8)
            .expect("a valid IWI in capture mode");
        if bind {
            capture.set_texture(pipe, 0, texture).expect("bind page 0");
        }
        capture
            .submit(pipe, &sprite(0), 1, RECORD_SIZE, 0)
            .expect("the capture state stages the frame");
        capture.present(&mut None).expect("a capture presents");
        capture
    }

    /// The bytes a nested frame leaves for the outer guest, with the outer
    /// device's page numbers in them.
    fn forwarded(capture: &Render2dState) -> Vec<u8> {
        let mut bytes = vec![0u8; capture.captured_bytes()];
        capture
            .forward_into(&mut bytes, NESTED_PAGE_BASE)
            .expect("the page base fits");
        bytes
    }

    /// `nested_iwi_lands_at_outer_page_base`.
    ///
    /// The outer draws blue from page 0; the nested guest loads red and binds it
    /// at its own page 0. After the replay, the forwarded record names page 1 and
    /// the frame is **red**: page 0 was not touched and the nested atlas is one
    /// page up. A replay that skipped either step draws the outer's blue here.
    #[test]
    fn nested_iwi_lands_at_outer_page_base() {
        let _serial = SDL.lock().unwrap_or_else(|poison| poison.into_inner());
        let Some(mut outer) = canvas() else { return };

        let blue = outer
            .texture_load(&solid([0, 0, 255, 255]), TEX_RGBA8)
            .expect("the outer's own texture");
        outer.set_texture(1, 0, blue).expect("the outer binds page 0");

        let capture = nested(true);
        let replay = outer
            .replay_deferred(capture.deferred(), NESTED_PAGE_BASE)
            .expect("the replay builds the nested scene");

        let pipe = *replay
            .pipelines
            .get(&1)
            .expect("the nested preset 1 was built on this device");
        assert!(
            pipe >= crate::render2d::pipeline::PIPE_RAW_MIN,
            "the replay builds its own pipeline, so the id is in the runtime range: got {pipe}"
        );
        assert_ne!(pipe, 1, "and it is not the id the capture used — preset 1 belongs to the UI");
        assert_eq!(replay.textures.len(), 1, "one texture was recorded and loaded");
        assert_eq!(
            replay.pages,
            vec![(pipe, NESTED_PAGE_BASE, 2)],
            "the recorded page 0 is bound one page up, as the outer's texture 2"
        );

        let records = forwarded(&capture);
        outer
            .submit(pipe, &records, 1, RECORD_SIZE, 0)
            .expect("the outer submits the forwarded frame");
        outer.present(&mut None).expect("present");
        frame_is(&mut outer, [255, 0, 0, 255], "nested_iwi_lands_at_outer_page_base");
    }

    /// `nested_guest_implicit_page_zero_is_reapplied_at_base`.
    ///
    /// The same frame, but the nested guest never calls `set_texture`: its record
    /// names page 0 and means "the atlas I just loaded", which is what a
    /// presenting state would serve. The replay has to make that explicit **at
    /// the base** — not at 0, where the outer's blue lives.
    #[test]
    fn nested_guest_implicit_page_zero_is_reapplied_at_base() {
        let _serial = SDL.lock().unwrap_or_else(|poison| poison.into_inner());
        let Some(mut outer) = canvas() else { return };

        let blue = outer
            .texture_load(&solid([0, 0, 255, 255]), TEX_RGBA8)
            .expect("the outer's own texture");
        outer.set_texture(1, 0, blue).expect("the outer binds page 0");

        let capture = nested(false);
        assert!(
            capture.deferred().bindings.is_empty(),
            "the guest bound nothing, which is the case under test"
        );
        let replay = outer
            .replay_deferred(capture.deferred(), NESTED_PAGE_BASE)
            .expect("the replay reapplies the implicit page");

        let pipe = *replay.pipelines.get(&1).expect("the nested preset 1");
        assert_eq!(
            replay.pages,
            vec![(pipe, NESTED_PAGE_BASE, 2)],
            "the implicit page 0 is bound at the base, not at 0"
        );

        let records = forwarded(&capture);
        outer
            .submit(pipe, &records, 1, RECORD_SIZE, 0)
            .expect("submit");
        outer.present(&mut None).expect("present");
        frame_is(
            &mut outer,
            [255, 0, 0, 255],
            "nested_guest_implicit_page_zero_is_reapplied_at_base",
        );
    }

    /// `a_preset_the_outer_already_draws_gets_a_second_pipeline`.
    ///
    /// **The editor's exact case, measured before it worked.** The editor's UI is
    /// preset 1 with 640x500 font pages; the nested isometric scene is preset 1
    /// with 128x128 pages. A replay that resolved preset 1 to the id the UI already
    /// holds sent every nested page into the UI's array and was refused
    /// (`-EINVAL`, "every page of one pipeline shares the array's size"), so the
    /// demo drew nothing. Here the outer's page is 2x1 and the nested's is 8x8: the
    /// replay has to give the nested guest a pipeline of its own, and the outer's
    /// own record must still draw the outer's atlas through the *same* page 0.
    #[test]
    fn a_preset_the_outer_already_draws_gets_a_second_pipeline() {
        let _serial = SDL.lock().unwrap_or_else(|poison| poison.into_inner());
        let Some(mut outer) = canvas() else { return };

        // The outer's UI: preset 1, its own small atlas at page 0.
        let blue = outer
            .texture_load(&solid([0, 0, 255, 255]), TEX_RGBA8)
            .expect("the outer's own texture");
        outer.set_texture(1, 0, blue).expect("the outer binds preset 1 page 0");

        let capture = nested(true);
        let replay = outer
            .replay_deferred(capture.deferred(), NESTED_PAGE_BASE)
            .expect("the nested guest's preset 1 must not be refused by the outer's");
        let pipe = *replay.pipelines.get(&1).expect("a pipeline for the nested preset 1");
        assert_ne!(pipe, 1, "a second pipeline, not the UI's");
        assert_eq!(
            replay.pages,
            vec![(pipe, NESTED_PAGE_BASE, 2)],
            "the nested page went to the nested pipeline, not into the UI's array"
        );

        // The nested frame draws the nested atlas...
        let records = forwarded(&capture);
        outer.submit(pipe, &records, 1, RECORD_SIZE, 0).expect("submit nested");
        outer.present(&mut None).expect("present");
        frame_is(
            &mut outer,
            [255, 0, 0, 255],
            "a_preset_the_outer_already_draws_gets_a_second_pipeline (nested)",
        );

        // ...and the outer's own record still draws its own, from the same page 0.
        outer.submit(1, &sprite(0), 1, RECORD_SIZE, 0).expect("submit outer");
        outer.present(&mut None).expect("present");
        frame_is(
            &mut outer,
            [0, 0, 255, 255],
            "a_preset_the_outer_already_draws_gets_a_second_pipeline (outer)",
        );
    }

    /// `a_differently_sized_outer_atlas_is_not_written_into_the_nested_pipeline`.
    ///
    /// The outer's implicit texture is a small generated atlas (the editor's
    /// 128x32 box cells); the nested scene's pages are 1024x1024. One array has
    /// one size, so the outer's texture cannot be page 0 of the nested pipeline —
    /// and binding it there would refuse the whole replay. The replay skips the
    /// preservation, binds the nested page at the base, and the frame draws.
    #[test]
    fn a_differently_sized_outer_atlas_is_not_written_into_the_nested_pipeline() {
        let _serial = SDL.lock().unwrap_or_else(|poison| poison.into_inner());
        let Some(mut outer) = canvas() else { return };

        // The outer's own atlas: 2x1, one page, never bound explicitly.
        let mut small = Vec::with_capacity(36 + 4 * 6 + 8);
        small.extend_from_slice(&crate::render2d::iwi::iwi_bytes(2, 1, 4, &[9, 8, 7, 6, 5, 4, 3, 2]));
        outer
            .texture_load(&small, TEX_RGBA8)
            .expect("the outer's small atlas");

        // The nested frame's page is 8x8, like the canvas.
        let capture = nested(true);
        let replay = outer
            .replay_deferred(capture.deferred(), NESTED_PAGE_BASE)
            .expect("a size mismatch on the outer's implicit page must not refuse the replay");
        let pipe = *replay.pipelines.get(&1).expect("the nested preset 1");
        assert_eq!(
            replay.pages,
            vec![(pipe, NESTED_PAGE_BASE, 2)],
            "only the nested page is bound: the outer's 2x1 could not be page 0 of an 8x8 array"
        );

        let records = forwarded(&capture);
        outer.submit(pipe, &records, 1, RECORD_SIZE, 0).expect("submit");
        outer.present(&mut None).expect("present");
        frame_is(
            &mut outer,
            [255, 0, 0, 255],
            "a_differently_sized_outer_atlas_is_not_written_into_the_nested_pipeline",
        );
    }

    /// The other half of the implicit rule: making a nested page explicit must
    /// not cost the **outer** its implicit page 0.
    ///
    /// Here the outer loads blue and binds nothing — it relies on the implicit
    /// page, as every v1 caller does. The nested guest binds its own page 0. The
    /// replay has to write the outer's page 0 down (blue) before binding red at
    /// page 1, or the outer's own record would sample an unbound layer. The frame
    /// is blue: the outer's record, reading page 0, still gets the outer's
    /// texture.
    #[test]
    fn the_replay_keeps_the_outer_implicit_page_zero() {
        let _serial = SDL.lock().unwrap_or_else(|poison| poison.into_inner());
        let Some(mut outer) = canvas() else { return };

        outer
            .texture_load(&solid([0, 0, 255, 255]), TEX_RGBA8)
            .expect("the outer's own texture, never bound");

        let capture = nested(true);
        let replay = outer
            .replay_deferred(capture.deferred(), NESTED_PAGE_BASE)
            .expect("the replay builds the nested scene");
        assert_eq!(
            replay.pages,
            vec![(*replay.pipelines.get(&1).unwrap(), NESTED_PAGE_BASE, 2)],
            "the report names the nested page only; the outer's page 0 is not part of it"
        );

        // The outer's own record: page 0, exactly as it wrote it before Play.
        outer
            .submit(1, &sprite(0), 1, RECORD_SIZE, 0)
            .expect("submit");
        outer.present(&mut None).expect("present");
        frame_is(
            &mut outer,
            [0, 0, 255, 255],
            "the_replay_keeps_the_outer_implicit_page_zero",
        );
    }
}
