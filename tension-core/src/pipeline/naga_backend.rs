//! Runtime compilation: a graph blob in, SPIR-V out.
//!
//! The build embeds artifacts for the graphs it ships (`scripts/build-2d.mjs`
//! runs `compile_spirv` and stores the modules in a table keyed by blob hash).
//! This module is the other half: what happens when a guest hands over a graph
//! the build never saw.
//!
//! It is the same three steps the build performs, in the same order, using the
//! same code:
//!
//! 1. [`crate::pipeline::parser::parse`] — T2DG bytes to a `Graph`;
//! 2. [`crate::pipeline::validate::validate`] — before anything is lowered;
//! 3. [`crate::pipeline::glsl_backend::lower`] — the graph's stages to GLSL,
//!    through `tension-shadergen`;
//! 4. Naga — GLSL to SPIR-V.
//!
//! Step 4 is why Naga replaced `glslangValidator`: a build-time compiler cannot
//! compile at run time, and a capability that can only draw what it shipped is
//! not a compiler.
//!
//! # What this does *not* do
//!
//! It does not talk to a GPU, know what SDL is, or cache anything. A caller
//! decides when to compile and what to do with the bytes; `set_pipeline` keys
//! its table on the blob hash so a graph compiles once.

use naga::front::glsl::{Frontend, Options};
use naga::valid::{Capabilities, ValidationFlags, Validator};
use naga::ShaderStage;

use super::glsl_backend;
use super::{parser, validate, Graph, GraphError, Result};

/// The two stages' SPIR-V, ready for `SDL_CreateGPUShader`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompiledPipeline {
    /// SPIR-V words, not bytes: the byte view is little-endian and every
    /// consumer here wants the words.
    pub vertex: Vec<u32>,
    pub fragment: Vec<u32>,
    /// The GLSL the stages came from. Kept because a failed
    /// `SDL_CreateGPUShader` is almost impossible to diagnose from SPIR-V, and
    /// the source is what a human can read.
    pub vertex_source: String,
    pub fragment_source: String,
}

impl CompiledPipeline {
    pub fn vertex_bytes(&self) -> Vec<u8> {
        words_to_bytes(&self.vertex)
    }

    pub fn fragment_bytes(&self) -> Vec<u8> {
        words_to_bytes(&self.fragment)
    }
}

pub fn words_to_bytes(words: &[u32]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(words.len() * 4);
    for word in words {
        bytes.extend_from_slice(&word.to_le_bytes());
    }
    bytes
}

/// Compile a graph that has already been parsed and validated.
///
/// Separate from [`compile`] so a caller holding a `Graph` — the build, or a
/// test — does not re-parse.
pub fn compile_graph(graph: &Graph) -> Result<CompiledPipeline> {
    let stage = graph
        .stages
        .first()
        .ok_or_else(|| GraphError::Invalid("no stages".to_string()))?;

    let lowered = glsl_backend::lower(graph, stage)?;

    let vertex = compile_glsl(&lowered.vertex, ShaderStage::Vertex).map_err(|error| {
        GraphError::Unsupported(format!(
            "vertex stage did not compile: {error}\n--- source ---\n{}",
            lowered.vertex
        ))
    })?;
    let fragment = compile_glsl(&lowered.fragment, ShaderStage::Fragment).map_err(|error| {
        GraphError::Unsupported(format!(
            "fragment stage did not compile: {error}\n--- source ---\n{}",
            lowered.fragment
        ))
    })?;

    Ok(CompiledPipeline {
        vertex,
        fragment,
        vertex_source: lowered.vertex,
        fragment_source: lowered.fragment,
    })
}

/// Parse, validate, lower and compile a T2DG blob.
pub fn compile(blob: &[u8]) -> Result<CompiledPipeline> {
    let graph = parser::parse(blob)?;
    validate::validate(&graph)?;
    compile_graph(&graph)
}

/// GLSL to SPIR-V, the one place Naga's writer options are chosen.
///
/// The flags are explicitly empty rather than `Options::default()`, and that is
/// a measured decision, not a stylistic one:
///
/// - `Options::default()` in Naga 29 includes `ADJUST_COORDINATE_SPACE`, which
///   flips Y on `gl_Position`. Reaching for it is tempting — glslangValidator
///   flips Y when it compiles GLSL for Vulkan — but Naga's *GLSL frontend*
///   already produces Vulkan-oriented clip space, so the flag is a second flip.
///   With it, every sprite renders mirrored (measured: the smoke suite drew at
///   y 328..359 instead of 0..31).
/// - The default also sets `DEBUG` under `cfg!(debug_assertions)`, so a debug
///   build and a release build would emit different SPIR-V. The build compares
///   the graph's modules against the preset's byte for byte, and that
///   comparison must not depend on the profile.
pub fn compile_glsl(source: &str, stage: ShaderStage) -> std::result::Result<Vec<u32>, String> {
    let mut frontend = Frontend::default();
    let module = frontend
        .parse(
            &Options {
                stage,
                defines: Default::default(),
            },
            source,
        )
        .map_err(|error| format!("naga parse: {error:?}"))?;

    let mut validator = Validator::new(ValidationFlags::all(), Capabilities::all());
    let info = validator
        .validate(&module)
        .map_err(|error| format!("naga validate: {error:?}"))?;

    let options = naga::back::spv::Options {
        flags: naga::back::spv::WriterFlags::empty(),
        ..naga::back::spv::Options::default()
    };
    let mut words: Vec<u32> = Vec::new();
    naga::back::spv::Writer::new(&options)
        .map_err(|error| format!("naga writer: {error:?}"))?
        .write(&module, &info, None, &None, &mut words)
        .map_err(|error| format!("naga emit: {error:?}"))?;

    // Naga cannot declare a combined sampler — its GLSL frontend refuses the
    // token and its IR has no such type — so a texture and its sampler always
    // come out as two bindings. SDL_GPU's Vulkan backend declares one
    // combined binding per sampler slot and refuses the pipeline otherwise.
    // Fold the pair here, where every module the renderer uses passes through.
    tension_shadergen::combined_sampler::fold_combined_samplers(&mut words)
        .map_err(|error| format!("combined sampler fold: {error}"))?;

    Ok(words)
}

const SPIRV_MAGIC: u32 = 0x0723_0203;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pipeline_default::{scaled_graph, serialize_default_2d};

    #[test]
    fn the_shipped_graph_compiles_at_runtime() {
        let compiled = compile(&serialize_default_2d()).expect("compile");
        assert_eq!(compiled.vertex.first(), Some(&SPIRV_MAGIC));
        assert_eq!(compiled.fragment.first(), Some(&SPIRV_MAGIC));
        assert!(compiled.vertex.len() > 5);
        assert!(compiled.fragment.len() > 5);
    }

    #[test]
    fn the_scaled_graph_compiles_at_runtime() {
        let blob = crate::pipeline_default::serialize_default_2d_scaled();
        let compiled = compile(&blob).expect("compile");
        assert_eq!(compiled.vertex.first(), Some(&SPIRV_MAGIC));
        // The graph's `mul` reached the source, or this proves nothing.
        assert!(compiled.vertex_source.contains("* 2.0"));
    }

    /// The graph the runtime test in `scripts/test-2d.mjs` builds: 1.5x.
    #[test]
    fn a_one_and_a_half_scale_graph_compiles() {
        let mut graph = scaled_graph();
        let stage = &mut graph.stages[0];
        let constant = stage
            .nodes
            .iter()
            .position(|n| n.id == 14)
            .expect("const_f32 node");
        let bits = 1.5f32.to_bits();
        stage.nodes[constant].args = vec![(bits & 0xFFFF) as u16, (bits >> 16) as u16];

        let compiled = compile_graph(&graph).expect("compile");
        assert_eq!(compiled.vertex.first(), Some(&SPIRV_MAGIC));
        assert!(compiled.vertex_source.contains("* 1.5"));
    }

    #[test]
    fn an_invalid_blob_is_refused_before_compiling() {
        // A blob that parses but does not validate must not reach Naga.
        let mut blob = serialize_default_2d();
        // Truncate the tail: still magic+version, but a broken TLV.
        blob.truncate(blob.len() - 3);
        assert!(compile(&blob).is_err());
    }

    #[test]
    fn the_two_shipped_graphs_compile_to_different_modules() {
        let a = compile(&serialize_default_2d()).expect("compile");
        let b = crate::pipeline_default::serialize_default_2d_scaled();
        let b = compile(&b).expect("compile");
        assert_ne!(a.vertex, b.vertex, "the scaled graph compiled to the same module");
    }
}

#[cfg(test)]
mod timing {
    use super::*;
    use std::time::Instant;

    /// Reports the cost of one cold compile, which is what `set_pipeline` pays
    /// for a graph the build never saw. Not an assertion — timings on shared CI
    /// are not assertions — but printed so the number is in the record.
    #[test]
    fn a_cold_compile_is_measured() {
        let blob = crate::pipeline_default::serialize_default_2d_scaled();
        let mut samples = Vec::new();
        for _ in 0..5 {
            let start = Instant::now();
            let _ = compile(&blob).expect("compile");
            samples.push(start.elapsed());
        }
        samples.sort();
        println!(
            "naga cold compile: median {:.3} ms, min {:.3} ms, max {:.3} ms",
            samples[2].as_secs_f64() * 1e3,
            samples[0].as_secs_f64() * 1e3,
            samples[4].as_secs_f64() * 1e3
        );
    }
}
