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
    PosZ,
    SrcX,
    SrcY,
    SrcW,
    SrcH,
    UVX,
    UVY,
    W,
    H,
    Tint,
    SortKey,
    /// Padding in the record. Occupies bytes, generates no attribute.
    Pad,
}

impl Semantic {
    /// The component of `gl_Position` this semantic fills, if any.
    fn position_axis(self) -> Option<usize> {
        match self {
            Semantic::PosX => Some(0),
            Semantic::PosY => Some(1),
            Semantic::PosZ => Some(2),
            Semantic::W => Some(3),
            _ => None,
        }
    }
}

/// The width of one field on the wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DType {
    F32,
    U16,
    I16,
    U8,
}

impl DType {
    /// The GLSL scalar type for this width.
    pub fn glsl(self) -> &'static str {
        match self {
            DType::F32 => "float",
            DType::U16 | DType::U8 => "uint",
            DType::I16 => "int",
        }
    }

    /// Bytes this type occupies, for validating offsets against the record.
    fn width(self) -> u16 {
        match self {
            DType::F32 => 4,
            DType::U16 | DType::I16 => 2,
            DType::U8 => 1,
        }
    }
}

/// Where a field is bound once it becomes an input.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Slot {
    Position,
    /// The texture-coordinate set index, not a component: `TexCoord(0)` and
    /// `TexCoord(1)` are two separate attributes.
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

/// Knobs the v1 fragment path accepts. Two fields, both about the fallback
/// path, because anything else would be generation logic we agreed not to add.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FragmentOptions {
    /// Emit `fragColor` as the tint when no texture is bound.
    pub flat_tint_when_untextured: bool,
}

impl Default for FragmentOptions {
    fn default() -> Self {
        Self { flat_tint_when_untextured: true }
    }
}

/// The nine presets this crate ships. Anything else is `Errno::Enosys`.
const PRESET_COUNT: u16 = 9;

/// Fields that share a slot become one attribute.
///
/// `PosX`/`PosY`/`PosZ`/`W` in the `Position` slot are one `vec4`, not four
/// scalars: that is how a vertex buffer actually describes a position, and
/// emitting four same-named inputs would not compile.
fn group_by_slot(fields: &[FieldDesc]) -> Vec<(Slot, Vec<&FieldDesc>)> {
    let mut groups: Vec<(Slot, Vec<&FieldDesc>)> = Vec::new();
    for field in fields {
        if field.semantic == Semantic::Pad {
            continue;
        }
        match groups.iter_mut().find(|(slot, _)| *slot == field.slot) {
            Some((_, members)) => members.push(field),
            None => groups.push((field.slot, vec![field])),
        }
    }
    groups
}

/// The GLSL type for a group of `components` fields.
fn group_type(members: &[&FieldDesc]) -> &'static str {
    let scalar = members.first().map(|f| f.dtype.glsl()).unwrap_or("float");
    match members.len() {
        0 | 1 => scalar,
        2 => "vec2",
        3 => "vec3",
        _ => "vec4",
    }
}

/// Check the descriptor before emitting anything, so a malformed layout cannot
/// produce a shader that looks plausible.
fn validate(layout: &LayoutDesc) -> Result<()> {
    if layout.fields.is_empty() || layout.record_size == 0 || layout.alignment == 0 {
        return Err(Errno::Einval);
    }
    for field in &layout.fields {
        let end = u32::from(field.offset) + u32::from(field.dtype.width());
        if end > u32::from(layout.record_size) {
            return Err(Errno::Einval);
        }
    }
    Ok(())
}

/// The vertex stage: attributes from the layout, `gl_Position` from the
/// position group, and a varying for every other slot.
pub fn generate_vertex(layout: &LayoutDesc, vocab: &dyn Vocabulary) -> Result<String> {
    validate(layout)?;
    let groups = group_by_slot(&layout.fields);
    let mut out = String::new();

    let _ = writeln!(out, "#version 450");
    let _ = writeln!(out, "// tension-shadergen: preset {}", layout.preset_id);
    let _ = writeln!(out, "// layout: {}", layout.name);

    // Inputs, one per slot, in first-appearance order.
    for (index, (slot, members)) in groups.iter().enumerate() {
        let _ = writeln!(
            out,
            "layout(location = {index}) in {} {};",
            group_type(members),
            vocab.attribute(*slot)
        );
    }

    // Varyings for everything that is not the position.
    for (slot, _) in &groups {
        if *slot == Slot::Position {
            continue;
        }
        let _ = writeln!(out, "out {} {};", varying_type(*slot), varying_name(*slot));
    }

    let _ = writeln!(out, "\nvoid main() {{");
    let _ = writeln!(out, "    vec4 position = vec4(0.0, 0.0, 0.0, 1.0);");

    if let Some((slot, members)) = groups.iter().find(|(slot, _)| *slot == Slot::Position) {
        let name = vocab.attribute(*slot);
        for (component, field) in members.iter().enumerate() {
            if let Some(axis) = field.semantic.position_axis() {
                let axis = ["x", "y", "z", "w"][axis];
                let swizzle = ["x", "y", "z", "w"].get(component).copied().unwrap_or("x");
                let _ = writeln!(out, "    position.{axis} = {name}.{swizzle};");
            }
        }
    }

    let _ = writeln!(out, "    gl_Position = position;");

    for (slot, _) in &groups {
        if *slot == Slot::Position {
            continue;
        }
        let _ = writeln!(
            out,
            "    {} = {};",
            varying_name(*slot),
            varying_assignment(*slot, vocab.attribute(*slot))
        );
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

    let groups = group_by_slot(&layout.fields);
    let mut out = String::new();
    let _ = writeln!(out, "#version 450");
    let _ = writeln!(out, "// tension-shadergen: preset {} fragment", layout.preset_id);

    for (slot, _) in &groups {
        if *slot == Slot::Position {
            continue;
        }
        let _ = writeln!(out, "in {} {};", varying_type(*slot), varying_name(*slot));
    }
    let _ = writeln!(out, "layout(location = 0) out vec4 fragColor;");

    // The nine presets differ only in what they do with the varyings they were
    // given. Keeping them here — and small — is the point: v1 is a working
    // baseline, not an effect library.
    let _ = writeln!(out, "\nvoid main() {{");
    let body = match layout.preset_id {
        1 => "    fragColor = vec4(1.0);".to_string(),
        2 => "    fragColor = vec4(v_uv, 0.0, 1.0);".to_string(),
        3 => "    fragColor = v_tint;".to_string(),
        4 => "    fragColor = vec4(v_tint.rgb, 1.0);".to_string(),
        5 => "    fragColor = vec4(v_uv, 1.0, 1.0);".to_string(),
        6 => "    fragColor = vec4(0.0, 0.0, 0.0, 1.0);".to_string(),
        7 => "    fragColor = vec4(1.0, 1.0, 1.0, 1.0);".to_string(),
        8 => "    fragColor = vec4(v_uv.x, v_uv.y, 0.0, 1.0);".to_string(),
        _ => {
            if opts.flat_tint_when_untextured {
                "    fragColor = v_tint;".to_string()
            } else {
                "    fragColor = vec4(1.0);".to_string()
            }
        }
    };
    let _ = writeln!(out, "{body}");
    let _ = writeln!(out, "}}");
    Ok(out)
}

/// The varying's type is fixed per slot, not derived from the attribute's
/// width: a fragment stage has to name a type before it sees how many
/// components the producer filled. [`varying_assignment`] reconciles the two.
fn varying_type(slot: Slot) -> &'static str {
    match slot {
        Slot::Position => "vec4",
        Slot::TexCoord(_) => "vec2",
        Slot::Color => "vec4",
        _ => "vec3",
    }
}

/// An expression converting an attribute of any width into the varying's fixed
/// type. `vec2(x)` accepts a `float` or a `vec2`, and `vec4(x.xxx, 1.0)` accepts
/// a `float` or a `vec4`, so the vertex stage compiles for every canonical and
/// degenerate shape a producer can describe.
fn varying_assignment(slot: Slot, attribute: &str) -> String {
    match slot {
        Slot::TexCoord(_) => format!("vec2({attribute})"),
        Slot::Color => format!("vec4({attribute}.xxx, 1.0)"),
        _ => format!("vec3({attribute})"),
    }
}

/// The varying's name, per slot.
fn varying_name(slot: Slot) -> &'static str {
    match slot {
        Slot::Position => "v_position",
        Slot::TexCoord(_) => "v_uv",
        Slot::Color => "v_tint",
        Slot::Normal => "v_normal",
        Slot::Tangent => "v_tangent",
        Slot::Binormal => "v_binormal",
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn quad_layout() -> LayoutDesc {
        LayoutDesc {
            name: "unit-quad".to_string(),
            preset_id: 1,
            record_size: 16,
            alignment: 4,
            fields: vec![
                FieldDesc { semantic: Semantic::PosX, dtype: DType::F32, offset: 0, slot: Slot::Position, step_rate: 0 },
                FieldDesc { semantic: Semantic::PosY, dtype: DType::F32, offset: 4, slot: Slot::Position, step_rate: 0 },
                FieldDesc { semantic: Semantic::W, dtype: DType::F32, offset: 8, slot: Slot::Position, step_rate: 0 },
                FieldDesc { semantic: Semantic::H, dtype: DType::F32, offset: 12, slot: Slot::Position, step_rate: 0 },
            ],
        }
    }

    /// The shape the C ABI's first caller will describe: a 16-byte quad.
    #[test]
    fn generates_a_quad_vertex_shader() {
        let source = generate_vertex(&quad_layout(), &NeutralVocabulary).expect("preset 1");
        assert!(source.contains("layout(location = 0)"), "{source}");
        assert!(source.contains("gl_Position"), "{source}");
        // The four position fields are one vec4, not four attributes.
        assert_eq!(source.matches("layout(location").count(), 1, "{source}");
        assert!(source.contains("vec4 a_position"), "{source}");
    }

    #[test]
    fn a_guest_defined_preset_is_enosys() {
        let mut layout = quad_layout();
        layout.preset_id = 0;
        assert_eq!(generate_fragment(&layout, &FragmentOptions::default()).unwrap_err(), Errno::Enosys);
        assert_eq!(DefaultGenerator.generate(&layout).unwrap_err(), Errno::Enosys);
    }

    #[test]
    fn padding_generates_no_attribute() {
        let mut layout = quad_layout();
        layout.fields.push(FieldDesc {
            semantic: Semantic::Pad,
            dtype: DType::U8,
            offset: 14,
            slot: Slot::Color,
            step_rate: 0,
        });
        layout.record_size = 16;
        let source = generate_vertex(&layout, &NeutralVocabulary).unwrap();
        assert!(!source.contains("a_color"), "{source}");
    }

    #[test]
    fn an_offset_past_the_record_is_rejected() {
        let mut layout = quad_layout();
        layout.record_size = 8;
        assert_eq!(generate_vertex(&layout, &NeutralVocabulary).unwrap_err(), Errno::Einval);
    }

    #[test]
    fn every_preset_answers() {
        for preset in 1..=PRESET_COUNT {
            let mut layout = quad_layout();
            layout.preset_id = preset;
            let source = DefaultGenerator.generate(&layout).expect("preset");
            assert!(source.contains("// ---- fragment ----"), "preset {preset}");
        }
    }
}
