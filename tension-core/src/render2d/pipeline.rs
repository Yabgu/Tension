//! Pipelines: the built-in preset, a guest's graph blob, and the SPIR-V that
//! both of them become.
//!
//! # The simplification this pass exists for
//!
//! In the C++ adapter, `set_pipeline` for a graph blob was a two-step dance
//! across the ABI. `set_pipeline_blob` looked the blob up by hash in the
//! artifacts the build had embedded and answered `-ENOSYS` for anything else;
//! the adapter then called the host's `compile_graph` slot *twice* — once with
//! null buffers to learn the sizes (`-ENOSPC` carries them), once with real
//! buffers to transfer the modules — and re-entered the renderer through
//! `set_pipeline_spirv` with what came back.
//!
//! Three calls, two buffers, and a size-probe convention, all to move bytes
//! between two processes that were already in the same address space.
//!
//! In core, the compiler is [`crate::pipeline::naga_backend`] and the renderer
//! is a function call away. [`PipelineCache::pipeline_for_blob`] parses,
//! validates, lowers and compiles in one call, then builds the pipeline. The
//! probe, the transfer and `set_pipeline_spirv` are gone.
//!
//! # Why the preset is compiled rather than embedded
//!
//! The C++ renderer embedded `kSpriteVertSpv`/`kSpriteFragSpv` in a generated C
//! header. In core, preset 1 is compiled from
//! [`crate::pipeline_default::default_graph`] — the same graph
//! `scripts/build-2d.mjs` compiles and then asserts is byte-identical to the
//! preset's SPIR-V. So the modules are the same bytes by construction, verified
//! by that build assertion, and there is no generated header to keep in step
//! with the compiler.
//!
//! The cost is one naga compile per process (cached in a [`OnceLock`]), paid at
//! the first `set_pipeline(1)`. The C++ path paid the same cost at build time
//! and shipped the bytes; both are ~30 ms of work either way
//! (`runtime_pipes`' note in `adapter.cpp` is the DSO's own measurement).
//!
//! SPDX-License-Identifier: MIT

use std::collections::BTreeMap;
use std::sync::OnceLock;

use sdl3::gpu::{
    BlendFactor, BlendOp, ColorTargetBlendState, ColorTargetDescription, CullMode, FillMode,
    GraphicsPipeline, GraphicsPipelineTargetInfo, MultisampleState, PrimitiveType, RasterizerState,
    ShaderFormat, ShaderStage, TextureFormat, VertexInputState,
};

use crate::render2d::error::Render2dError;

/// Pipelines one handle may hold (`kMaxPipelines` in the C++ renderer).
pub const MAX_PIPELINES: usize = 16;

/// `TENSION_2D_PIPE_PRESET_MIN` — the first built-in preset id.
pub const PIPE_PRESET_MIN: u16 = 1;
/// `TENSION_2D_PIPE_PRESET_MAX` — the last built-in preset id.
pub const PIPE_PRESET_MAX: u16 = 99;
/// `TENSION_2D_PIPE_GUEST_MIN` — the range `tension_2d.h` gives guest graphs.
pub const PIPE_GUEST_MIN: u32 = 100;
/// `TENSION_2D_PIPE_RAW_MIN` — the first id for a graph compiled at runtime.
pub const PIPE_RAW_MIN: u32 = 1000;

/// FNV-1a 64 over a blob: the key a compiled pipeline is cached under.
///
/// Must agree with `pipeline::Graph::hash` in Rust and `fnv1a` in
/// `scripts/build-2d.mjs`, because all three name the same blob. The test
/// `graph_hash_matches_the_graph_module` in `tests/render2d_parity.rs` holds
/// this to `Graph::hash` so the two cannot drift.
pub fn graph_hash(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for &byte in bytes {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// The graphs whose artifacts the C++ build shipped, with the ids it gave them.
///
/// `scripts/build-2d.mjs` pins `default_2d` at 100 and `default_2d_scaled` at
/// 101 (`PIPE_IDS`). The hashes are computed here from the blobs
/// `pipeline_default` serializes — the same blobs the build wrote to
/// `tension-2d/tests/*.t2dg` — rather than transcribed, so a change to the graph
/// changes the hash and the two implementations disagree loudly instead of
/// silently routing to different pipelines.
fn builtin_graphs() -> &'static [(u64, u32)] {
    static BUILTINS: OnceLock<Vec<(u64, u32)>> = OnceLock::new();
    BUILTINS.get_or_init(|| {
        vec![
            (
                graph_hash(&crate::pipeline_default::serialize_default_2d()),
                PIPE_GUEST_MIN,
            ),
            (
                graph_hash(&crate::pipeline_default::serialize_default_2d_scaled()),
                PIPE_GUEST_MIN + 1,
            ),
        ]
    })
}

/// The id a built-in graph's blob resolves to, if this build ships it.
pub fn builtin_pipe_id(hash: u64) -> Option<u32> {
    builtin_graphs()
        .iter()
        .find(|(known, _)| *known == hash)
        .map(|(_, id)| *id)
}

/// Preset 1's SPIR-V, compiled once per process.
///
/// `scripts/build-2d.mjs` asserts these bytes equal the preset the C++ build
/// embedded, so this is a substitution and not a second shader.
fn preset_spirv() -> Result<&'static (Vec<u8>, Vec<u8>), Render2dError> {
    static PRESET: OnceLock<Result<(Vec<u8>, Vec<u8>), String>> = OnceLock::new();
    let compiled = PRESET.get_or_init(|| {
        let graph = crate::pipeline_default::default_graph();
        crate::pipeline::naga_backend::compile_graph(&graph)
            .map(|compiled| {
                (
                    compiled.vertex_bytes().to_vec(),
                    compiled.fragment_bytes().to_vec(),
                )
            })
            .map_err(|error| format!("preset 1 did not compile: {error}"))
    });
    match compiled {
        Ok(modules) => Ok(modules),
        Err(message) => Err(Render2dError::Unsupported(message.clone())),
    }
}

/// Compile a guest's graph blob to a module pair, in one call.
///
/// This is the whole of what used to be `-ENOSYS` + two `compile_graph` calls.
pub fn compile_blob(blob: &[u8]) -> Result<(Vec<u8>, Vec<u8>), Render2dError> {
    let compiled = crate::pipeline::naga_backend::compile(blob).map_err(|error| {
        // The compiler's own errno, so a guest that could tell a malformed
        // blob from an unsupported graph over the ABI can still tell them
        // apart in core.
        let message = format!("{error}");
        match error {
            crate::pipeline::GraphError::Malformed(_)
            | crate::pipeline::GraphError::Invalid(_) => Render2dError::Invalid(message),
            crate::pipeline::GraphError::Unsupported(_) => Render2dError::Unsupported(message),
        }
    })?;
    Ok((
        compiled.vertex_bytes().to_vec(),
        compiled.fragment_bytes().to_vec(),
    ))
}

/// Build one graphics pipeline from a compiled module pair.
///
/// The state is `render.cpp:334-421`'s, field for field, because a pipeline is
/// where a "byte-identical frame" claim is either kept or lost:
///
/// * **straight alpha, source-over.** The default is `enable_blend = false`, so
///   without this every transparent texel writes something and a sprite cut-out
///   draws as an opaque black rectangle.
/// * **no vertex buffers.** Every field comes from the storage buffer; the
///   vertex shader synthesizes each quad from `gl_InstanceIndex`.
/// * **one colour target, `R8G8B8A8_UNORM`.** The target texture's format, and
///   the only one this renderer allocates.
fn build_pipeline(
    device: &sdl3::gpu::Device,
    vs: &[u8],
    fs: &[u8],
) -> Result<GraphicsPipeline, Render2dError> {
    let entrypoint = std::ffi::CString::new("main").expect("no NUL in a literal");

    let vertex = device
        .create_shader()
        .with_code(ShaderFormat::SPIRV, vs, ShaderStage::Vertex)
        .with_entrypoint(&entrypoint)
        .with_storage_buffers(1) // set 0, binding 0: the record array
        .with_uniform_buffers(1) // set 1, binding 0: the canvas
        .build()
        .map_err(|error| Render2dError::Io(format!("CreateGPUShader(vertex): {error}")))?;

    let fragment = device
        .create_shader()
        .with_code(ShaderFormat::SPIRV, fs, ShaderStage::Fragment)
        .with_entrypoint(&entrypoint)
        .with_samplers(1) // set 2: one texture-sampler pair (u_tex + u_sampler)
        .build()
        .map_err(|error| Render2dError::Io(format!("CreateGPUShader(fragment): {error}")))?;

    let blend = ColorTargetBlendState::new()
        .with_enable_blend(true)
        .with_src_color_blendfactor(BlendFactor::SrcAlpha)
        .with_dst_color_blendfactor(BlendFactor::OneMinusSrcAlpha)
        .with_color_blend_op(BlendOp::Add)
        .with_src_alpha_blendfactor(BlendFactor::One)
        .with_dst_alpha_blendfactor(BlendFactor::OneMinusSrcAlpha)
        .with_alpha_blend_op(BlendOp::Add);

    let targets = [ColorTargetDescription::new()
        .with_format(TextureFormat::R8g8b8a8Unorm)
        .with_blend_state(blend)];
    let target_info =
        GraphicsPipelineTargetInfo::new().with_color_target_descriptions(&targets);

    device
        .create_graphics_pipeline()
        .with_vertex_shader(&vertex)
        .with_fragment_shader(&fragment)
        .with_primitive_type(PrimitiveType::TriangleList)
        .with_rasterizer_state(
            RasterizerState::new()
                .with_fill_mode(FillMode::Fill)
                .with_cull_mode(CullMode::None),
        )
        .with_multisample_state(MultisampleState::new())
        .with_vertex_input_state(VertexInputState::new())
        .with_target_info(target_info)
        .build()
        .map_err(|error| Render2dError::Io(format!("CreateGPUGraphicsPipeline: {error}")))
}

/// The pipelines one canvas holds, keyed by `pipe_id`.
pub struct PipelineCache {
    /// Built graphics pipelines. `BTreeMap` rather than `HashMap` only so
    /// `info`'s counts and any future listing are deterministic.
    pipelines: BTreeMap<u32, GraphicsPipeline>,
    /// Blob hashes this process already compiled, and the id each became.
    ///
    /// `adapter.cpp:48-50`'s `runtime_pipes`: without it a guest that re-set the
    /// same graph would compile it again, which is ~30 ms and a new pipeline
    /// object every time.
    by_blob: BTreeMap<u64, u32>,
    next_runtime_pipe: u32,
}

/// The default is [`PipelineCache::new`], including the runtime id base.
/// Deriving it would leave `next_runtime_pipe` at 0, and the first compiled
/// graph would take pipe id 0 — below `TENSION_2D_PIPE_GUEST_MIN`, a value
/// `tension_2d.h` never allocates.
impl Default for PipelineCache {
    fn default() -> Self {
        Self::new()
    }
}

impl PipelineCache {
    pub fn new() -> Self {
        PipelineCache {
            pipelines: BTreeMap::new(),
            by_blob: BTreeMap::new(),
            next_runtime_pipe: PIPE_RAW_MIN,
        }
    }

    /// How many pipelines are built.
    pub fn len(&self) -> usize {
        self.pipelines.len()
    }

    /// The pipeline for an id, if it is built.
    pub fn get(&self, pipe_id: u32) -> Option<&GraphicsPipeline> {
        self.pipelines.get(&pipe_id)
    }

    /// Whether an id names a built pipeline.
    pub fn contains(&self, pipe_id: u32) -> bool {
        self.pipelines.contains_key(&pipe_id)
    }

    /// Resolve a built-in preset id to a pipeline id, building it if needed.
    ///
    /// Only preset 1 is built: it is the one `tension-shadergen` emits and the
    /// one the graphs are compared against. Any other id in `1..=99` is
    /// recognised and refused with `-ENOSYS`, which is what the DSO did — the
    /// difference between "not a preset" (`-ENOENT`) and "a preset this build
    /// does not carry" (`-ENOSYS`) is information a log reader uses.
    pub fn preset(
        &mut self,
        device: &sdl3::gpu::Device,
        preset_id: u16,
    ) -> Result<u32, Render2dError> {
        if !(PIPE_PRESET_MIN..=PIPE_PRESET_MAX).contains(&preset_id) {
            return Err(Render2dError::NotFound(
                "set_pipeline: preset id outside 1..99".to_string(),
            ));
        }
        if preset_id != 1 {
            return Err(Render2dError::Unsupported(format!(
                "set_pipeline: preset '{preset_id}' is not built into this adapter"
            )));
        }
        let id = u32::from(preset_id);
        if self.pipelines.contains_key(&id) {
            return Ok(id);
        }
        self.reserve_slot()?;
        let (vs, fs) = preset_spirv()?;
        let pipeline = build_pipeline(device, vs, fs)?;
        self.pipelines.insert(id, pipeline);
        Ok(id)
    }

    /// Resolve a guest's graph blob to a pipeline id.
    ///
    /// Three cases, in the order the DSO tried them:
    ///
    /// 1. a blob this process already compiled → its id, no work;
    /// 2. a blob matching a graph the build ships → that graph's pinned id
    ///    (100 or 101), compiled at build time in the C++ path and here;
    /// 3. anything else → compile it and take the next id from 1000 up, which
    ///    is the range `tension_2d.h` reserves for runtime-compiled graphs.
    pub fn blob(
        &mut self,
        device: &sdl3::gpu::Device,
        blob: &[u8],
    ) -> Result<u32, Render2dError> {
        if blob.is_empty() {
            return Err(Render2dError::Invalid(
                "set_pipeline: empty blob".to_string(),
            ));
        }
        let hash = graph_hash(blob);
        if let Some(id) = self.by_blob.get(&hash) {
            return Ok(*id);
        }

        if let Some(id) = builtin_pipe_id(hash) {
            if !self.pipelines.contains_key(&id) {
                self.reserve_slot()?;
                let (vs, fs) = compile_blob(blob)?;
                let pipeline = build_pipeline(device, &vs, &fs)?;
                self.pipelines.insert(id, pipeline);
            }
            self.by_blob.insert(hash, id);
            return Ok(id);
        }

        self.reserve_slot()?;
        let (vs, fs) = compile_blob(blob)?;
        let id = self.next_runtime_pipe;
        let pipeline = build_pipeline(device, &vs, &fs)?;
        self.pipelines.insert(id, pipeline);
        // Only after the build succeeded, so a failure does not burn an id or
        // poison the cache with a mapping to a pipeline that does not exist.
        self.next_runtime_pipe += 1;
        self.by_blob.insert(hash, id);
        Ok(id)
    }

    fn reserve_slot(&self) -> Result<(), Render2dError> {
        if self.pipelines.len() >= MAX_PIPELINES {
            return Err(Render2dError::Full(
                "set_pipeline: pipeline table full".to_string(),
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_is_fnv1a_64() {
        // The FNV-1a 64 of the empty string is the offset basis, and of "a" the
        // value every implementation agrees on. Both are invariants of the
        // algorithm, not of this code.
        assert_eq!(graph_hash(b""), 0xcbf2_9ce4_8422_2325);
        assert_eq!(graph_hash(b"a"), 0xaf63_dc4c_8601_ec8c);
    }

    /// The two shipped graphs hash to the ids `scripts/build-2d.mjs` pins.
    #[test]
    fn shipped_graphs_are_recognised() {
        let default_blob = crate::pipeline_default::serialize_default_2d();
        let scaled_blob = crate::pipeline_default::serialize_default_2d_scaled();
        assert_eq!(
            builtin_pipe_id(graph_hash(&default_blob)),
            Some(PIPE_GUEST_MIN)
        );
        assert_eq!(
            builtin_pipe_id(graph_hash(&scaled_blob)),
            Some(PIPE_GUEST_MIN + 1)
        );
    }

    /// An arbitrary blob is not a shipped graph, so it takes the runtime range.
    #[test]
    fn an_unknown_blob_is_not_a_shipped_graph() {
        assert_eq!(builtin_pipe_id(graph_hash(b"not a graph")), None);
    }
}
