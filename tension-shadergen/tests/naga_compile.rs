//! Does Naga's GLSL frontend accept what `tension-shadergen` emits?
//!
//! This is the gate for replacing `glslangValidator` with Naga in the build,
//! and it is the gate for runtime pipeline compilation: a capability that
//! cannot turn its own GLSL into SPIR-V cannot compile a graph at run time.
//!
//! # What the first run found
//!
//! The vertex stage parsed, validated and emitted on the first try. The
//! fragment stage did not:
//!
//! ```text
//! ParseErrors { errors: [Error {
//!     kind: NotImplemented("variable qualifier"),
//!     meta: Span { start: 128, end: 137 },
//! }] }
//! ```
//!
//! Byte 128 of that fragment source is the `sampler2D` token in
//! `layout(set = 2, binding = 0) uniform sampler2D u_tex;`. Naga's GLSL frontend
//! does not implement opaque-type uniforms at all — the rejection is in
//! `parser/declarations.rs`, on the branch that handles a qualified
//! declaration whose type is not a block, and it fires for the combined
//! sampler in *every* layout form (with `set`, with `binding`, and with
//! neither).
//!
//! So the fix was generator-side and mechanical: emit Vulkan-style
//! `uniform texture2D` plus `uniform sampler` at adjacent bindings, and sample
//! with `texture(sampler2D(u_tex, u_sampler), uv)`. SPIR-V has no combined
//! sampler type — the combined spelling lowers to exactly the same two
//! descriptors — so this is a change of spelling, not of meaning. The one
//! consequence outside the shader is that SDL_GPU's `num_samplers` counts
//! descriptors, so the fragment stage now declares 2.
//!
//! What this file therefore asserts, for both stages of both graphs: Naga
//! parses it, Naga validates it, and the SPIR-V it emits is real SPIR-V.

use naga::front::glsl::{Frontend, Options};
use naga::valid::{Capabilities, ValidationFlags, Validator};
use naga::ShaderStage;

use tension_shadergen::{
    generate_fragment, generate_vertex, DType, FieldDesc, FragmentOptions, LayoutDesc, Semantic,
    Slot, Vocabulary,
};

/// The `sprite` record as the shader sees it (DESIGN.md §5). Named `classic2d`
/// because that is what the 16-byte fixture was called before the batcher; the
/// layout here is the real 28-byte one, which is what the adapter ships.
fn sprite_layout() -> LayoutDesc {
    tension_shadergen::sprite_layout()
}

/// `compile` is the thing Naga has to do for the adapter, so it is the thing
/// this test exercises: parse, validate, emit, and hand back words.
fn to_spirv(source: &str, stage: ShaderStage) -> Result<Vec<u32>, String> {
    let mut frontend = Frontend::default();
    let options = Options {
        stage,
        defines: Default::default(),
    };
    let module = frontend
        .parse(&options, source)
        .map_err(|e| format!("{e:?}"))?;

    let mut validator = Validator::new(ValidationFlags::all(), Capabilities::all());
    let info = validator
        .validate(&module)
        .map_err(|e| format!("{e:?}"))?;

    let mut words: Vec<u32> = Vec::new();
    naga::back::spv::Writer::new(&naga::back::spv::Options::default())
        .expect("SPIR-V writer options")
        .write(&module, &info, None, &None, &mut words)
        .map_err(|e| format!("{e:?}"))?;
    Ok(words)
}

const SPIRV_MAGIC: u32 = 0x0723_0203;

fn assert_real_spirv(words: &[u32], what: &str) {
    assert!(!words.is_empty(), "{what}: no words emitted");
    assert_eq!(words[0], SPIRV_MAGIC, "{what}: wrong magic {:#010x}", words[0]);
    // The header is five words (magic, version, generator, bound, schema).
    assert!(words.len() > 5, "{what}: header only, no instruction stream");
}

#[test]
fn the_vertex_stage_compiles_through_naga() {
    let source = generate_vertex(&sprite_layout(), &tension_shadergen::NeutralVocabulary)
        .expect("vertex generation");
    let words = to_spirv(&source, ShaderStage::Vertex).unwrap_or_else(|e| {
        panic!("naga rejected the vertex stage:\n{e}\n--- source ---\n{source}")
    });
    assert_real_spirv(&words, "vertex");
}

#[test]
fn the_fragment_stage_compiles_through_naga() {
    let source = generate_fragment(&sprite_layout(), &FragmentOptions::default())
        .expect("fragment generation");
    let words = to_spirv(&source, ShaderStage::Fragment).unwrap_or_else(|e| {
        panic!("naga rejected the fragment stage:\n{e}\n--- source ---\n{source}")
    });
    assert_real_spirv(&words, "fragment");
}

/// Every preset, because a preset that compiles is not evidence that the other
/// eight do — the fragment bodies differ per preset.
#[test]
fn every_preset_compiles_through_naga() {
    for preset in 1..=9u16 {
        let mut layout = sprite_layout();
        layout.preset_id = preset;

        let vertex = generate_vertex(&layout, &tension_shadergen::NeutralVocabulary)
            .expect("vertex generation");
        let words = to_spirv(&vertex, ShaderStage::Vertex)
            .unwrap_or_else(|e| panic!("preset {preset} vertex:\n{e}\n{vertex}"));
        assert_real_spirv(&words, "vertex");

        let fragment = generate_fragment(&layout, &FragmentOptions::default())
            .expect("fragment generation");
        let words = to_spirv(&fragment, ShaderStage::Fragment)
            .unwrap_or_else(|e| panic!("preset {preset} fragment:\n{e}\n{fragment}"));
        assert_real_spirv(&words, "fragment");
    }
}

/// The two names SDL_GPU spells differently still reach the compiler, so the
/// vocabulary seam survives the swap from glslang to Naga.
#[test]
fn a_custom_vocabulary_still_compiles() {
    struct SdlGpu;
    impl Vocabulary for SdlGpu {
        fn attribute(&self, slot: Slot) -> &'static str {
            match slot {
                Slot::Position => "a_position",
                Slot::TexCoord(0) => "a_uv0",
                Slot::TexCoord(1) => "a_uv1",
                Slot::Color => "a_colour",
                Slot::Normal => "a_normal",
                Slot::Tangent => "a_tangent",
                Slot::Binormal => "a_binormal",
                Slot::TexCoord(_) => "a_uv",
                Slot::TexPage => "a_tex",
            Slot::TexPage => "a_tex",
            }
        }
    }

    let mut layout = sprite_layout();
    layout.fields.push(FieldDesc {
        semantic: Semantic::Tint,
        dtype: DType::F32,
        offset: 16,
        slot: Slot::Color,
        step_rate: 0,
    });

    let vertex = generate_vertex(&layout, &SdlGpu).expect("vertex generation");
    let words = to_spirv(&vertex, ShaderStage::Vertex)
        .unwrap_or_else(|e| panic!("tinted vertex:\n{e}\n{vertex}"));
    assert_real_spirv(&words, "vertex");

    let fragment =
        generate_fragment(&layout, &FragmentOptions::default()).expect("fragment generation");
    let words = to_spirv(&fragment, ShaderStage::Fragment)
        .unwrap_or_else(|e| panic!("tinted fragment:\n{e}\n{fragment}"));
    assert_real_spirv(&words, "fragment");
}

/// The exact construct Naga cannot represent. This test pins the reason the
/// generator emits separate texture and sampler declarations, so that a future
/// reader tempted to "simplify" back to `uniform sampler2D` finds this before
/// they find a build failure.
#[test]
fn naga_refuses_a_combined_sampler2d_uniform() {
    let source = "#version 450\n\
                  layout(location = 0) in vec2 uv;\n\
                  layout(set = 2, binding = 0) uniform sampler2D u_tex;\n\
                  layout(location = 0) out vec4 fragColor;\n\
                  void main() { fragColor = texture(u_tex, uv); }\n";

    let err = to_spirv(source, ShaderStage::Fragment)
        .expect_err("naga must still reject a combined opaque uniform");
    assert!(
        err.contains("variable qualifier"),
        "the rejection changed shape; re-check the generator's workaround:\n{err}"
    );
}
