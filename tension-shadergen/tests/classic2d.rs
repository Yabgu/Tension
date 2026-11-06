//! `classic2d` — the sprite-batcher conformance test, compiled for real.
//!
//! The previous revision of this crate had a test that asserted `gl_Position`
//! *appeared* in the generated source. It passed while the shader was wrong: the
//! 16-byte quad produced `position.w = a_position.z`, putting the sprite's width
//! in the homogeneous divisor and dropping `H` entirely.
//!
//! So this file checks two separate things, and neither of them is "the string
//! contains a keyword":
//!
//! 1. **The arithmetic.** [`the_quad_arithmetic_is_asserted_term_by_term`] pins
//!    the exact expression that computes each corner, so a change to the
//!    position model fails here rather than on someone's screen.
//! 2. **That it is a shader.** [`the_generated_pair_compiles`] runs
//!    `glslangValidator` on both stages and fails if either does not compile.
//!    A string assertion cannot catch a type error; a compiler can.
//!
//! The layout is the `sprite` record from DESIGN.md §5: 28 bytes, natural
//! alignment, `x`/`y` as `i32` pixels, `src_x`/`src_y`/`w`/`h` as `u16`.

use std::process::Command;

use tension_shadergen::{
    generate_fragment, generate_vertex, FieldDesc, FragmentOptions, LayoutDesc, Semantic, Slot,
    DType, Vocabulary,
};

/// The `sprite` record as the shader sees it.
fn classic2d() -> LayoutDesc {
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
            Slot::TexCoord(_) => "a_uv",
            Slot::TexPage => "a_tex",
        }
    }
}

/// The values, term by term.
///
/// `position.x == record.x + corner_x * record.w` and
/// `position.y == record.y + corner_y * record.h` are the two equations the
/// sprite batcher is; the UV line is the third.
#[test]
fn the_quad_arithmetic_is_asserted_term_by_term() {
    let source = generate_vertex(&classic2d(), &SdlGpuVocabulary).expect("preset 1");

    // The corner table: (0,0) (1,0) (1,1) and (0,0) (1,1) (0,1) — two triangles
    // covering the rectangle, which is what 6 vertices per instance means.
    assert!(source.contains("vec2(0.0, 0.0), vec2(1.0, 0.0), vec2(1.0, 1.0),"), "{source}");
    assert!(source.contains("vec2(0.0, 0.0), vec2(1.0, 1.0), vec2(0.0, 1.0))"), "{source}");
    assert!(source.contains("const vec2 corner = kCorners[gl_VertexIndex];"), "{source}");

    // position.x = x + corner_x * w
    assert!(source.contains("vec2 px = vec2(a_position_x + corner.x * a_position_w,"), "{source}");
    // position.y = y + corner_y * h
    assert!(source.contains("a_position_y + corner.y * a_position_h);"), "{source}");

    // z == 0, w == 1. A 2D quad has no perspective divisor to set.
    assert!(source.contains("gl_Position = vec4(clip, 0.0, 1.0);"), "{source}");
    assert!(!source.contains("position.w ="), "the perspective divisor came back:\n{source}");

    // out_uv maps corner (0,0) to src_rect and (1,1) to src_rect + src_size.
    assert!(
        source.contains("out_uv = vec2(a_uv0_x + corner.x * a_uv0_w,"),
        "{source}"
    );
    assert!(source.contains("a_uv0_y + corner.y * a_uv0_h) / u_tex_size;"), "{source}");

    // And the record reads use the right offsets: x at word 0, w/h at word 3.
    assert!(source.contains("float a_position_x = float(int(r_words[base + 0u]));"), "{source}");
    assert!(source.contains("float a_position_w = float((r_words[base + 3u] >> 0u) & 0xFFFFu);"), "{source}");
    assert!(source.contains("float a_position_h = float((r_words[base + 3u] >> 16u) & 0xFFFFu);"), "{source}");
    // src_x at byte 8, src_y at byte 10.
    assert!(source.contains("float a_uv0_x = float((r_words[base + 2u] >> 0u) & 0xFFFFu);"), "{source}");
    assert!(source.contains("float a_uv0_y = float((r_words[base + 2u] >> 16u) & 0xFFFFu);"), "{source}");
}

/// A tinted layout must carry the colour varying, which the fragment stage then
/// reads. Their locations have to agree or the pair links to a black quad.
#[test]
fn the_two_stages_agree_on_varying_locations() {
    let mut layout = classic2d();
    layout.fields.push(FieldDesc {
        semantic: Semantic::Tint,
        dtype: DType::F32,
        offset: 16,
        slot: Slot::Color,
        step_rate: 0,
    });

    let vs = generate_vertex(&layout, &SdlGpuVocabulary).unwrap();
    let fs = generate_fragment(&layout, &FragmentOptions::default()).unwrap();

    assert!(vs.contains("layout(location = 0) out vec2 out_uv;"), "{vs}");
    assert!(vs.contains("layout(location = 1) out vec4 out_color;"), "{vs}");
    assert!(fs.contains("layout(location = 0) in vec2 out_uv;"), "{fs}");
    assert!(fs.contains("layout(location = 1) in vec4 out_color;"), "{fs}");
}

/// The compiler gate. `glslangValidator` is a documented build prerequisite
/// (DESIGN.md §8.1); if it is missing, this test fails rather than skipping,
/// because the alternative is a test suite that silently stops compiling
/// anything.
#[test]
fn the_generated_pair_compiles() {
    let vs = generate_vertex(&classic2d(), &SdlGpuVocabulary).expect("preset 1");
    let fs = generate_fragment(&classic2d(), &FragmentOptions::default()).expect("preset 1");

    let dir = std::env::temp_dir().join(format!("tension-shadergen-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("temp dir");

    for (stage, name, source) in [("vert", "classic2d.vert", &vs), ("frag", "classic2d.frag", &fs)] {
        let path = dir.join(name);
        std::fs::write(&path, source).expect("write shader");

        // `-V` (Vulkan SPIR-V) is what SDL_GPU's Vulkan backend consumes.
        //
        // The task that asked for this test specified `-G` (OpenGL SPIR-V).
        // That cannot compile this shader, and the reason is structural rather
        // than a version to bump: glslang's `-G` rejects the Vulkan-only builtin
        // spellings (`gl_InstanceIndex`, `gl_VertexIndex`) and rejects
        // `layout(set = N)`, which SDL_GPU requires for its fragment sampler at
        // set 2. A `-G`-compatible shader cannot sample a texture through
        // SDL_GPU at all. `-V` is therefore the gate, and DESIGN.md §8.1 records
        // the conflict.
        let output = Command::new("glslangValidator")
            .arg("-V")
            .arg("-S")
            .arg(stage)
            .arg(&path)
            .arg("-o")
            .arg(dir.join(format!("{name}.spv")))
            .output();

        let output = match output {
            Ok(output) => output,
            Err(error) => panic!(
                "could not run glslangValidator ({error}). It is a build prerequisite: \
                 DESIGN.md §8.1."
            ),
        };

        assert!(
            output.status.success(),
            "glslangValidator rejected the generated {stage} stage:\n{}\n{}\n--- source ---\n{source}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr),
        );
    }

    let _ = std::fs::remove_dir_all(&dir);
}
