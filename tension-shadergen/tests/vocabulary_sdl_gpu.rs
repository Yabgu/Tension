//! Vocabulary conformance: does `tension-shadergen`'s seam fit a second
//! renderer without changing the trait?
//!
//! DESIGN.md §6.7 makes this the gate before any adapter is scaffolded. The
//! crate's own vocabulary is neutral (`a_position`, `a_texcoord0`, …) and its
//! module doc claims the naming for a real renderer "lives in the adapter that
//! owns the renderer" — but no adapter in the tree implements `Vocabulary`, so
//! the seam had never been exercised from outside the crate. This test is that
//! exercise for SDL_GPU.
//!
//! What it proves if it passes: a renderer's naming can be supplied from
//! outside, through `&dyn Vocabulary`, with no access to the crate's internals
//! and no change to the trait.
//!
//! # What changed with the sprite batcher
//!
//! The vertex stage no longer declares vertex attributes — every field comes out
//! of a storage buffer — so a `Slot` now names a **group of loaded values**
//! rather than an attribute. `Slot::Position` becomes the prefix `a_position`,
//! and the generator appends `_x`, `_y`, `_w`, `_h` to it. The trait's contract
//! is unchanged (`fn attribute(&self, Slot) -> &'static str`) and so is its
//! purpose: the caller's name reaches the generated source. Only the thing the
//! name is attached to moved.

use tension_shadergen::{
    generate_vertex, DType, FieldDesc, LayoutDesc, Semantic, Slot, Vocabulary,
};

/// SDL_GPU's own spelling, as an adapter would supply it.
///
/// Deliberately *not* the crate's `NeutralVocabulary`: `a_uv0` and `a_colour`
/// differ from `a_texcoord0` and `a_color`, which is the point — if the output
/// carries these strings, the caller's vocabulary reached the generator.
struct SdlGpuVocabulary;

impl Vocabulary for SdlGpuVocabulary {
    fn attribute(&self, slot: Slot) -> &'static str {
        match slot {
            Slot::Position => "a_position",
            Slot::TexCoord(0) => "a_uv0",
            Slot::TexCoord(1) => "a_uv1",
            Slot::Color => "a_colour",
            Slot::Normal => "a_normal",
            Slot::Tangent => "a_tangent",
            Slot::Binormal => "a_binormal",
            // Unreachable for the layouts below; a name rather than a panic,
            // because a layout the host cannot serve should be refused upstream.
            Slot::TexCoord(_) => "a_uv",
            Slot::TexPage => "a_tex",
        }
    }
}

/// The 28-byte `sprite` record (DESIGN.md §5) as the shader sees it.
fn classic2d_layout() -> LayoutDesc {
    LayoutDesc {
        name: "classic2d".to_string(),
        preset_id: 1,
        record_size: 28,
        alignment: 4,
        fields: vec![
            FieldDesc { semantic: Semantic::PosX, dtype: DType::I32, offset: 0, slot: Slot::Position, step_rate: 0 },
            FieldDesc { semantic: Semantic::PosY, dtype: DType::I32, offset: 4, slot: Slot::Position, step_rate: 0 },
            FieldDesc { semantic: Semantic::SrcX, dtype: DType::U16, offset: 8, slot: Slot::TexCoord(0), step_rate: 0 },
            FieldDesc { semantic: Semantic::SrcY, dtype: DType::U16, offset: 10, slot: Slot::TexCoord(0), step_rate: 0 },
            FieldDesc { semantic: Semantic::W, dtype: DType::U16, offset: 12, slot: Slot::Position, step_rate: 0 },
            FieldDesc { semantic: Semantic::H, dtype: DType::U16, offset: 14, slot: Slot::Position, step_rate: 0 },
        ],
    }
}

#[test]
fn classic2d_vertex_shader_uses_the_sdl_gpu_vocabulary() {
    let source = generate_vertex(&classic2d_layout(), &SdlGpuVocabulary).expect("preset 1");

    assert!(source.contains("layout(location = 0)"), "no location 0:\n{source}");
    assert!(source.contains("gl_Position"), "no gl_Position:\n{source}");

    // The caller's names, attached to the values they name.
    assert!(source.contains("a_position_x"), "the position group name is missing:\n{source}");
    assert!(source.contains("a_uv0_x"), "the uv group name is missing:\n{source}");

    // And the neutral names must NOT be present: this is a different
    // vocabulary, not the default one renamed.
    assert!(!source.contains("a_texcoord0"), "neutral vocabulary leaked:\n{source}");

    // One quad per instance: six vertices from an instanced draw, no attributes.
    assert!(
        !source.contains("in vec"),
        "the batcher must not declare vertex attributes:\n{source}"
    );
    assert!(source.contains("gl_InstanceIndex"), "{source}");
}

/// A layout with a tint exercises the third group name, `a_colour`, which is
/// the spelling SDL_GPU's authors would choose and the crate's neutral
/// vocabulary would not.
#[test]
fn the_colour_group_uses_the_caller_spelling() {
    let mut layout = classic2d_layout();
    layout.fields.push(FieldDesc {
        semantic: Semantic::Tint,
        dtype: DType::F32,
        offset: 16,
        slot: Slot::Color,
        step_rate: 0,
    });

    let source = generate_vertex(&layout, &SdlGpuVocabulary).expect("preset 1");

    assert!(source.contains("a_colour"), "the SDL spelling of colour is missing:\n{source}");
    assert!(source.contains("out_color = a_colour;"), "{source}");
    assert!(!source.contains("a_color\n"), "neutral colour name leaked:\n{source}");
}

/// The trait takes `&self`, so one vocabulary instance serves many calls and a
/// generator could hold it across frames. Asserting it is object-safe and
/// shareable is cheap and documents the assumption.
#[test]
fn the_trait_is_usable_as_a_shared_dyn_reference() {
    let vocab: &dyn Vocabulary = &SdlGpuVocabulary;
    let a = generate_vertex(&classic2d_layout(), vocab).expect("preset 1");
    let b = generate_vertex(&classic2d_layout(), vocab).expect("preset 1");
    assert_eq!(a, b, "generation is not a pure function of the layout and vocabulary");
}
