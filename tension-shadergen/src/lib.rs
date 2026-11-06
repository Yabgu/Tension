//! Shader source generation: a layout description in, GLSL out.
//!
//! The division of labour this crate exists to keep is the DWARF arc's, moved
//! to shader text. The language/compiler knows what a vertex stream *is* — the
//! fields, their offsets, their semantics. The engine knows how to transport a
//! request and hand back a string. Neither invents the other's half: this crate
//! takes a [`LayoutDesc`] that a producer filled in and turns it into source,
//! with no global state, no I/O, and no knowledge of any renderer.
//!
//! What it deliberately does *not* know is what a renderer calls things. That
//! lives behind [`vocab::Vocabulary`], and the OGRE-specific naming lives in
//! `tension-ogre`'s adapter, which is the component that knows it is talking to
//! OGRE.
//!
//! # The sprite-batcher shape
//!
//! The vertex stage this crate emits is not a mesh transform. It is a sprite
//! batcher: **one quad per record**, synthesized in the vertex shader from a
//! storage-buffer read at `gl_InstanceIndex`, drawn with
//! `SDL_DrawGPUPrimitives(pass, 6, N, 0, 0)`.
//!
//! An earlier revision emitted a 3D mesh-transform shader: attributes in, a
//! `vec4` position out, `W` mapped onto the homogeneous `w`. For a sprite that
//! is wrong in a way that is easy to miss — `position.w = a_position.z` puts the
//! sprite's **width** in the perspective divisor and drops `H` entirely, so the
//! GPU divides the position by the sprite's width. A 2D quad has no perspective
//! divisor to set: it is `base + corner * size`, with `w = 1`.
//!
//! # Coordinate space
//!
//! Records carry **pixels**, because that is what a 2D game thinks in and what
//! the `sprite` record layout in DESIGN.md §5 defines. A pixel coordinate is not
//! a clip coordinate, so the generated vertex stage converts with a
//! `u_canvas_half` uniform (set 1, binding 0, pushed per draw). The corner
//! arithmetic the layout describes is emitted verbatim and asserted by the
//! tests; only the final projection is the generator's own addition.
//!
//! The nine built-in presets are the whole surface at v1. A layout naming a
//! preset outside that range is refused with [`Errno::Enosys`] rather than
//! guessed at — a wrong shader that compiles is worse than no shader, because
//! the failure moves from the host's return code to the user's screen.

pub mod vocab;

use std::fmt::Write as _;

pub use vocab::{NeutralVocabulary, Vocabulary};

/// What a field means to the consumer, independent of where it sits.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Semantic {
    PosX,
    PosY,
    /// Unused by the sprite stage; kept so the enum matches the C header's
    /// `TENSION_SEM_*` block (`tension_adapter.h:117–130`).
    PosZ,
    SrcX,
    SrcY,
    SrcW,
    SrcH,
    UVX,
    UVY,
    /// The sprite's on-screen width in pixels.
    W,
    /// The sprite's on-screen height in pixels.
    H,
    Tint,
    SortKey,
    /// Padding in the record. Occupies bytes, generates no load.
    Pad,
}

/// The width of one field on the wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DType {
    F32,
    U16,
    I16,
    U8,
    /// Signed 32-bit. Appended to the list rather than inserted (the C header's
    /// dtype codes are append-only, `tension_adapter.h:132–140`); the sprite
    /// record's `x`/`y` are signed pixels and none of the original four can
    /// express one.
    I32,
}

impl DType {
    /// The GLSL scalar type this value widens to.
    ///
    /// Every field widens to `float`: the quad arithmetic multiplies a u16
    /// width by a corner offset and adds it to an i32 position, and doing the
    /// widening in one place keeps the emitted body readable.
    pub fn glsl(self) -> &'static str {
        "float"
    }

    /// Bytes this type occupies, for validating offsets against the record.
    fn width(self) -> u16 {
        match self {
            DType::F32 | DType::I32 => 4,
            DType::U16 | DType::I16 => 2,
            DType::U8 => 1,
        }
    }

    /// Whether a value of this type must start on a 4-byte boundary to be read
    /// by a whole-word load.
    fn needs_word_alignment(self) -> bool {
        matches!(self, DType::F32 | DType::I32)
    }
}

/// Where a field is bound once it becomes an input.
///
/// The sprite stage has no vertex attributes — every field comes out of the
/// storage buffer — so a slot is now a **naming group**: it decides which
/// [`Vocabulary`] name a loaded value is given. `Slot::Position` names the
/// record's geometry, `Slot::TexCoord(0)` its source rectangle.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Slot {
    Position,
    /// The texture-coordinate set index, not a component: `TexCoord(0)` and
    /// `TexCoord(1)` are two separate groups.
    TexCoord(u8),
    Color,
    Normal,
    Tangent,
    Binormal,
}

/// One field of a vertex or instance record.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FieldDesc {
    pub semantic: Semantic,
    pub dtype: DType,
    /// Bytes from the start of the record.
    pub offset: u16,
    pub slot: Slot,
    /// `0` = per-vertex; `n` = per-instance, advanced every `n` steps.
    ///
    /// The sprite stage is instanced, so this is `0` for every field it uses.
    /// It stays in the descriptor because the C ABI carries it
    /// (`tension_adapter.h:431`).
    pub step_rate: u8,
}

/// One vertex or instance stream.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LayoutDesc {
    /// A name for diagnostics. Not compiled into the shader.
    pub name: String,
    /// One of the nine built-in presets, or `0` for a guest-defined layout.
    pub preset_id: u16,
    pub record_size: u16,
    pub alignment: u16,
    pub fields: Vec<FieldDesc>,
}

/// Why generation could not answer.
///
/// Deliberately the same three answers the C ABI can return, so the mapping in
/// `tension-core` is a projection rather than a translation table.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Errno {
    /// No preset for this layout. The caller should fall back, not fail.
    Enosys,
    /// The descriptor is malformed.
    Einval,
    /// The caller's buffer is too small.
    Enospc,
}

impl Errno {
    /// The negated errno the C ABI returns.
    pub fn code(self) -> i32 {
        match self {
            Errno::Enosys => -38,
            Errno::Einval => -22,
            Errno::Enospc => -28,
        }
    }
}

pub type Result<T> = std::result::Result<T, Errno>;

/// A producer of shader source for a layout.
///
/// One method, because the host's only question is "give me the shader for
/// this stream". How a generator splits vertex from fragment is its business.
pub trait ShaderGenerator {
    fn generate(&self, layout: &LayoutDesc) -> Result<String>;
}

/// Knobs the v1 fragment path accepts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FragmentOptions {
    /// Emit the record's tint when the texture supplies nothing. Only consulted
    /// by a layout with no `Tint` field, which cannot reference the varying at
    /// all; kept for source compatibility with the pre-batcher API.
    pub flat_tint_when_untextured: bool,
}

impl Default for FragmentOptions {
    fn default() -> Self {
        Self { flat_tint_when_untextured: true }
    }
}

/// The nine presets this crate ships. Anything else is `Errno::Enosys`.
const PRESET_COUNT: u16 = 9;

/// The six corner offsets of one quad, in the order
/// `SDL_DrawGPUPrimitives(6, N, 0, 0)` walks them: two triangles covering the
/// sprite's rectangle.
const CORNERS: [(u8, u8); 6] = [(0, 0), (1, 0), (1, 1), (0, 0), (1, 1), (0, 1)];

/// Check the descriptor before emitting anything, so a malformed layout cannot
/// produce a shader that looks plausible.
fn validate(layout: &LayoutDesc) -> Result<()> {
    if layout.fields.is_empty() || layout.record_size == 0 || layout.alignment == 0 {
        return Err(Errno::Einval);
    }
    // The record is read as whole `uint` words, so its size must be word
    // aligned or the last field would share a word with bytes that do not
    // exist.
    if layout.record_size % 4 != 0 {
        return Err(Errno::Einval);
    }
    for field in &layout.fields {
        let end = u32::from(field.offset) + u32::from(field.dtype.width());
        if end > u32::from(layout.record_size) {
            return Err(Errno::Einval);
        }
        // A 32-bit value cannot be extracted from a word it does not start on.
        if field.dtype.needs_word_alignment() && field.offset % 4 != 0 {
            return Err(Errno::Einval);
        }
    }
    Ok(())
}

fn field(layout: &LayoutDesc, semantic: Semantic) -> Option<&FieldDesc> {
    layout.fields.iter().find(|f| f.semantic == semantic)
}

fn need(layout: &LayoutDesc, semantic: Semantic) -> Result<&FieldDesc> {
    field(layout, semantic).ok_or(Errno::Einval)
}

/// A GLSL expression yielding a field's value as a `float`.
fn load(field: &FieldDesc) -> String {
    let word = u32::from(field.offset) / 4;
    let shift = (u32::from(field.offset) % 4) * 8;
    match field.dtype {
        DType::F32 => format!("uintBitsToFloat(r_words[base + {word}u])"),
        DType::I32 => format!("float(int(r_words[base + {word}u]))"),
        DType::U16 => format!("float((r_words[base + {word}u] >> {shift}u) & 0xFFFFu)"),
        DType::U8 => format!("float((r_words[base + {word}u] >> {shift}u) & 0xFFu)"),
        // Sign-extend by shifting the half-word to the top and back down.
        DType::I16 => {
            let left = 32 - (shift + 16);
            format!("float(int(r_words[base + {word}u] << {left}u) >> 16)")
        }
    }
}

/// The vertex stage: one quad per record, read from the storage buffer.
pub fn generate_vertex(layout: &LayoutDesc, vocab: &dyn Vocabulary) -> Result<String> {
    validate(layout)?;
    let stride = u32::from(layout.record_size) / 4;

    let pos_x = need(layout, Semantic::PosX)?;
    let pos_y = need(layout, Semantic::PosY)?;
    let size_w = need(layout, Semantic::W)?;
    let size_h = need(layout, Semantic::H)?;
    let src_x = need(layout, Semantic::SrcX)?;
    let src_y = need(layout, Semantic::SrcY)?;
    // A layout without an explicit source size samples the whole sprite rect,
    // which is what the `sprite` record in DESIGN.md §5 does: it carries one
    // `w`/`h` pair serving both the quad and the source.
    let src_w = field(layout, Semantic::SrcW).unwrap_or(size_w);
    let src_h = field(layout, Semantic::SrcH).unwrap_or(size_h);
    let tint = field(layout, Semantic::Tint);

    let geom = vocab.attribute(pos_x.slot);
    let uv = vocab.attribute(src_x.slot);
    let name = |group: &str, suffix: &str| format!("{group}_{suffix}");

    let mut out = String::new();
    let _ = writeln!(out, "#version 450");
    let _ = writeln!(out, "// tension-shadergen: sprite-batcher vertex stage");
    let _ = writeln!(out, "// preset {}, layout {}", layout.preset_id, layout.name);
    let _ = writeln!(
        out,
        "// record {} bytes ({stride} words), alignment {}",
        layout.record_size, layout.alignment
    );
    let _ = writeln!(out, "//");
    let _ = writeln!(out, "// One quad per record, read at gl_InstanceIndex.");
    let _ = writeln!(out, "// Draw with SDL_DrawGPUPrimitives(pass, 6, N, 0, 0).");
    let _ = writeln!(out);
    let _ = writeln!(out, "layout(std430, binding = 0) readonly buffer Records {{");
    let _ = writeln!(out, "    uint r_words[];");
    let _ = writeln!(out, "}};");
    let _ = writeln!(out);
    // One uniform block, two facts: the canvas for the pixel->clip projection
    // and the atlas size for the pixel->normalized-UV one. `texture()` takes
    // normalized coordinates while the record carries pixels (DESIGN.md §5), so
    // without the second the sampler reads a clamp-to-edge smear instead of the
    // sprite's cell. On a solid-colour texture that mistake is invisible, which
    // is exactly why it survived the first smoke test.
    let _ = writeln!(out, "layout(set = 1, binding = 0) uniform CanvasBlock {{");
    let _ = writeln!(out, "    vec2 u_canvas_half;");
    let _ = writeln!(out, "    vec2 u_tex_size;");
    let _ = writeln!(out, "}};");
    let _ = writeln!(out);
    let _ = writeln!(out, "layout(location = 0) out vec2 out_uv;");
    if tint.is_some() {
        let _ = writeln!(out, "layout(location = 1) out vec4 out_color;");
    }
    let _ = writeln!(out);
    let _ = writeln!(out, "void main() {{");
    let _ = writeln!(out, "    const uint kStride = {stride}u;");
    let _ = writeln!(out, "    const uint base = uint(gl_InstanceIndex) * kStride;");
    let _ = writeln!(out);
    let _ = writeln!(
        out,
        "    // The six corners: (0,0) (1,0) (1,1) and (0,0) (1,1) (0,1)."
    );
    let _ = writeln!(out, "    const vec2 kCorners[6] = vec2[6](");
    let corners: Vec<String> = CORNERS
        .iter()
        .map(|(x, y)| format!("vec2({x}.0, {y}.0)"))
        .collect();
    let _ = writeln!(out, "        {},", corners[..3].join(", "));
    let _ = writeln!(out, "        {});", corners[3..].join(", "));
    let _ = writeln!(out, "    const vec2 corner = kCorners[gl_VertexIndex];");
    let _ = writeln!(out);
    let _ = writeln!(out, "    // record fields, widened to float");
    for (suffix, f) in [("x", pos_x), ("y", pos_y), ("w", size_w), ("h", size_h)] {
        let _ = writeln!(out, "    float {} = {};", name(geom, suffix), load(f));
    }
    for (suffix, f) in [("x", src_x), ("y", src_y), ("w", src_w), ("h", src_h)] {
        let _ = writeln!(out, "    float {} = {};", name(uv, suffix), load(f));
    }
    if let Some(t) = tint {
        let _ = writeln!(
            out,
            "    vec4 {} = vec4({}, 1.0, 1.0, 1.0);",
            vocab.attribute(t.slot),
            load(t)
        );
    }
    let _ = writeln!(out);
    let _ = writeln!(
        out,
        "    vec2 px = vec2({gx} + corner.x * {gw},",
        gx = name(geom, "x"),
        gw = name(geom, "w")
    );
    let _ = writeln!(
        out,
        "                   {gy} + corner.y * {gh});",
        gy = name(geom, "y"),
        gh = name(geom, "h")
    );
    let _ = writeln!(out, "    vec2 clip = vec2(px.x / u_canvas_half.x - 1.0,");
    let _ = writeln!(out, "                     1.0 - px.y / u_canvas_half.y);");
    let _ = writeln!(out, "    gl_Position = vec4(clip, 0.0, 1.0);");
    let _ = writeln!(out);
    let _ = writeln!(
        out,
        "    // Pixel src rect -> normalized UV.",
    );
    let _ = writeln!(
        out,
        "    out_uv = vec2({ux} + corner.x * {uw},",
        ux = name(uv, "x"),
        uw = name(uv, "w")
    );
    let _ = writeln!(
        out,
        "                  {uy} + corner.y * {uh}) / u_tex_size;",
        uy = name(uv, "y"),
        uh = name(uv, "h")
    );
    if let Some(t) = tint {
        let _ = writeln!(out, "    out_color = {};", vocab.attribute(t.slot));
    }
    let _ = writeln!(out, "}}");
    Ok(out)
}

/// The fragment stage for one preset.
pub fn generate_fragment(layout: &LayoutDesc, opts: &FragmentOptions) -> Result<String> {
    validate(layout)?;
    if layout.preset_id == 0 || layout.preset_id > PRESET_COUNT {
        return Err(Errno::Enosys);
    }
    let _ = opts;

    let has_tint = field(layout, Semantic::Tint).is_some();
    let tint = if has_tint { "out_color" } else { "vec4(1.0)" };

    let mut out = String::new();
    let _ = writeln!(out, "#version 450");
    let _ = writeln!(out, "// tension-shadergen: preset {} fragment", layout.preset_id);
    let _ = writeln!(out);
    let _ = writeln!(out, "layout(location = 0) in vec2 out_uv;");
    if has_tint {
        let _ = writeln!(out, "layout(location = 1) in vec4 out_color;");
    }
    let _ = writeln!(out, "layout(set = 2, binding = 0) uniform sampler2D u_tex;");
    let _ = writeln!(out, "layout(location = 0) out vec4 fragColor;");
    let _ = writeln!(out);
    let _ = writeln!(out, "void main() {{");

    // The nine presets differ only in what they do with the sampler and the
    // tint they were given. Keeping them here — and small — is the point: v1 is
    // a working baseline, not an effect library.
    let body = match layout.preset_id {
        1 => "fragColor = texture(u_tex, out_uv);".to_string(),
        2 => format!("fragColor = texture(u_tex, out_uv) * {tint};"),
        3 => format!("fragColor = vec4({tint}.rgb, texture(u_tex, out_uv).a * {tint}.a);"),
        4 => format!("fragColor = texture(u_tex, out_uv) + {tint};"),
        5 => format!("fragColor = vec4(texture(u_tex, out_uv).rgb * {tint}.rgb, 1.0);"),
        6 => "fragColor = vec4(out_uv, 0.0, 1.0);".to_string(),
        7 => "fragColor = vec4(1.0);".to_string(),
        8 => format!("fragColor = vec4(texture(u_tex, out_uv).rgb, {tint}.a);"),
        _ => format!("fragColor = {tint};"),
    };
    let _ = writeln!(out, "    {body}");
    let _ = writeln!(out, "}}");
    Ok(out)
}

/// The generator registered at v1: vertex and fragment, presets 1..=9 only.
///
/// `generate` returns both stages in one string, vertex first, separated by a
/// marker comment. One `String` because the C ABI has one output buffer; the
/// marker is what keeps the pair readable to whoever splits it.
pub struct DefaultGenerator;

impl ShaderGenerator for DefaultGenerator {
    fn generate(&self, layout: &LayoutDesc) -> Result<String> {
        if layout.preset_id == 0 || layout.preset_id > PRESET_COUNT {
            return Err(Errno::Enosys);
        }
        let mut source = generate_vertex(layout, &NeutralVocabulary)?;
        let _ = writeln!(source, "\n// ---- fragment ----");
        source.push_str(&generate_fragment(layout, &FragmentOptions::default())?);
        Ok(source)
    }
}

/// The generator the host registers at startup.
pub fn default_generator() -> DefaultGenerator {
    DefaultGenerator
}

/// The `sprite` record layout (DESIGN.md §5), as the generator sees it.
///
/// Kept beside the generator because the adapter's build, the tests and any
/// future guest SDK all need the same description, and copies would drift. The
/// offsets are the header's (`tension_2d.h`); `tex`, `group_id`, `z` and `flags`
/// are absent on purpose — the adapter reads those on the CPU for sorting and
/// binding, and a field the shader never loads should not be in its layout.
pub fn sprite_layout() -> LayoutDesc {
    LayoutDesc {
        name: "sprite".to_string(),
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

#[cfg(test)]
mod tests {
    use super::*;

    /// The 28-byte `sprite` record (DESIGN.md §5): x, y, src_x, src_y, w, h,
    /// sort_key. `tex`, `group_id`, `z` and `flags` are absent because the
    /// shader never loads them — the adapter reads those on the CPU.
    fn sprite() -> LayoutDesc {
        LayoutDesc {
            name: "sprite".to_string(),
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
                FieldDesc { semantic: Semantic::SortKey, dtype: DType::F32, offset: 20, slot: Slot::Color, step_rate: 0 },
            ],
        }
    }

    #[test]
    fn the_quad_arithmetic_is_base_plus_corner_times_size() {
        let source = generate_vertex(&sprite(), &NeutralVocabulary).expect("preset 1");
        // The values, not merely the presence of gl_Position.
        assert!(
            source.contains("float a_position_x = float(int(r_words[base + 0u]));"),
            "{source}"
        );
        assert!(
            source.contains("float a_position_w = float((r_words[base + 3u] >> 0u) & 0xFFFFu);"),
            "{source}"
        );
        assert!(
            source.contains("vec2 px = vec2(a_position_x + corner.x * a_position_w,"),
            "{source}"
        );
        assert!(
            source.contains("a_position_y + corner.y * a_position_h);"),
            "{source}"
        );
        // A 2D quad: no perspective divisor, and no dropped component.
        assert!(source.contains("gl_Position = vec4(clip, 0.0, 1.0);"), "{source}");
        assert!(!source.contains("position.w"), "{source}");
    }

    #[test]
    fn the_source_rect_maps_corner_to_src_rect() {
        let source = generate_vertex(&sprite(), &NeutralVocabulary).expect("preset 1");
        assert!(
            source.contains("float a_texcoord0_x = float((r_words[base + 2u] >> 0u) & 0xFFFFu);"),
            "{source}"
        );
        assert!(
            source.contains("out_uv = vec2(a_texcoord0_x + corner.x * a_texcoord0_w,"),
            "{source}"
        );
        assert!(
            source.contains("a_texcoord0_y + corner.y * a_texcoord0_h) / u_tex_size;"),
            "{source}"
        );
    }

    #[test]
    fn a_tint_field_becomes_one_varying() {
        let mut layout = sprite();
        layout.fields.push(FieldDesc {
            semantic: Semantic::Tint,
            dtype: DType::F32,
            offset: 24,
            slot: Slot::Color,
            step_rate: 0,
        });
        let source = generate_vertex(&layout, &NeutralVocabulary).expect("preset 1");
        assert!(source.contains("layout(location = 1) out vec4 out_color;"), "{source}");
        assert!(source.contains("out_color = a_color;"), "{source}");
    }

    #[test]
    fn a_layout_without_a_size_is_rejected() {
        let mut layout = sprite();
        layout.fields.retain(|f| f.semantic != Semantic::W);
        assert_eq!(
            generate_vertex(&layout, &NeutralVocabulary).unwrap_err(),
            Errno::Einval
        );
    }

    #[test]
    fn a_record_size_that_is_not_word_aligned_is_rejected() {
        let mut layout = sprite();
        layout.record_size = 27;
        assert_eq!(
            generate_vertex(&layout, &NeutralVocabulary).unwrap_err(),
            Errno::Einval
        );
    }

    #[test]
    fn an_offset_past_the_record_is_rejected() {
        let mut layout = sprite();
        layout.record_size = 8;
        assert_eq!(
            generate_vertex(&layout, &NeutralVocabulary).unwrap_err(),
            Errno::Einval
        );
    }

    #[test]
    fn a_float_at_a_half_word_offset_is_rejected() {
        let mut layout = sprite();
        layout.fields.push(FieldDesc {
            semantic: Semantic::Tint,
            dtype: DType::F32,
            offset: 18,
            slot: Slot::Color,
            step_rate: 0,
        });
        assert_eq!(
            generate_vertex(&layout, &NeutralVocabulary).unwrap_err(),
            Errno::Einval
        );
    }

    #[test]
    fn a_guest_defined_preset_is_enosys() {
        let mut layout = sprite();
        layout.preset_id = 0;
        assert_eq!(
            generate_fragment(&layout, &FragmentOptions::default()).unwrap_err(),
            Errno::Enosys
        );
        assert_eq!(DefaultGenerator.generate(&layout).unwrap_err(), Errno::Enosys);
    }

    #[test]
    fn every_preset_answers() {
        for preset in 1..=PRESET_COUNT {
            let mut layout = sprite();
            layout.preset_id = preset;
            let source = DefaultGenerator.generate(&layout).expect("preset");
            assert!(source.contains("// ---- fragment ----"), "preset {preset}");
            assert!(source.contains("gl_Position"), "preset {preset}");
        }
    }

    #[test]
    fn the_fragment_samples_at_set_two() {
        let source = generate_fragment(&sprite(), &FragmentOptions::default()).unwrap();
        // SDL_GPU's Vulkan backend binds fragment samplers at set 2
        // (`SDL_gpu.h:2705–2715`); anything else binds nothing.
        assert!(
            source.contains("layout(set = 2, binding = 0) uniform sampler2D u_tex;"),
            "{source}"
        );
    }
}
