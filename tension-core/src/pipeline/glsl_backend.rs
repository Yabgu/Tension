//! The GPU lowering: graph stage -> GLSL, through `tension-shadergen`.
//!
//! The generator is *called*, not replaced. `tension-shadergen` already knows
//! how to turn a [`LayoutDesc`] into a sprite-batcher vertex stage and a
//! fragment stage; what it does not know is where a `LayoutDesc` comes from.
//! Here it comes from the graph: the RECORD supplies the fields and their
//! offsets, the STAGE supplies the canvas, and `emit_quad`'s inputs say which
//! loaded value plays which role.
//!
//! # What is checked rather than assumed
//!
//! A lowering that ignored `emit_quad`'s wiring would compile *some* shader for
//! *any* graph, which is the failure mode this module exists to avoid. So the
//! emit node is read: its seven inputs must be six `load_field` nodes naming
//! x, y, w, h, src_x, src_y in that order, plus one `sort_by`. A graph that
//! wires them differently is `-ENOSYS` here — not silently reordered, because
//! "we compiled what you meant" and "we compiled what you said" diverge
//! quietly.

use tension_shadergen::{
    generate_fragment, generate_vertex, DType as SgDType, FieldDesc, FragmentOptions, LayoutDesc,
    NeutralVocabulary, Semantic as SgSemantic, Slot,
};

use super::{Graph, GraphError, Result, Semantic, Stage, DType};

/// The two stages' source, ready for a compiler.
pub struct Lowered {
    pub vertex: String,
    pub fragment: String,
    /// The layout the generator was given, kept for diagnostics and for the
    /// byte-identity check against the built-in preset.
    pub layout: LayoutDesc,
}

fn sg_dtype(dtype: DType) -> Option<SgDType> {
    Some(match dtype {
        DType::F32 => SgDType::F32,
        DType::U16 => SgDType::U16,
        DType::I16 => SgDType::I16,
        DType::U8 => SgDType::U8,
        DType::I32 => SgDType::I32,
        // The generator has no unsigned 32-bit load: nothing it emits reads a
        // u32 field (sort_key is the CPU's business). A layout naming one is
        // refused rather than widened, because widening would change the bits
        // a shader computes with.
        DType::U32 => return None,
    })
}

fn sg_semantic(semantic: Semantic) -> Option<SgSemantic> {
    Some(match semantic {
        Semantic::PosX => SgSemantic::PosX,
        Semantic::PosY => SgSemantic::PosY,
        Semantic::SrcX => SgSemantic::SrcX,
        Semantic::SrcY => SgSemantic::SrcY,
        Semantic::SrcW => SgSemantic::SrcW,
        Semantic::SrcH => SgSemantic::SrcH,
        Semantic::W => SgSemantic::W,
        Semantic::H => SgSemantic::H,
        Semantic::Tint => SgSemantic::Tint,
        Semantic::SortKey => SgSemantic::SortKey,
        Semantic::Pad => SgSemantic::Pad,
        // Not shader inputs: the CPU reads these for ordering and binding.
        Semantic::PosZ
        | Semantic::UvX
        | Semantic::UvY
        | Semantic::GroupId
        | Semantic::Z
        | Semantic::Flags
        | Semantic::Tex => return None,
    })
}

fn slot_for(semantic: Semantic) -> Option<Slot> {
    Some(match semantic {
        Semantic::PosX | Semantic::PosY | Semantic::PosZ | Semantic::W | Semantic::H => Slot::Position,
        Semantic::SrcX | Semantic::SrcY | Semantic::SrcW | Semantic::SrcH => Slot::TexCoord(0),
        Semantic::UvX | Semantic::UvY => Slot::TexCoord(1),
        Semantic::Tint => Slot::Color,
        _ => return None,
    })
}

/// Build the generator's layout from a stage's record.
pub fn layout_for(graph: &Graph, stage: &Stage) -> Result<LayoutDesc> {
    let record = graph
        .records
        .get(usize::from(stage.record_ref))
        .ok_or_else(|| {
            GraphError::Invalid(format!(
                "stage `{}`: record_ref {} is out of range",
                stage.name, stage.record_ref
            ))
        })?;

    let mut fields = Vec::new();
    for field in &record.fields {
        // Fields the shader does not consume are skipped, not an error: the
        // record carries `tex`, `group_id`, `z` and `flags` for the CPU.
        let (Some(semantic), Some(slot)) = (sg_semantic(field.semantic), slot_for(field.semantic))
        else {
            continue;
        };
        let dtype = sg_dtype(field.dtype).ok_or_else(|| {
            GraphError::Unsupported(format!(
                "stage `{}`: field `{}` has dtype {:?} which the shader generator cannot load",
                stage.name, field.name, field.dtype
            ))
        })?;
        fields.push(FieldDesc {
            semantic,
            dtype,
            offset: field.offset,
            slot,
            step_rate: 0,
        });
    }

    if fields.is_empty() {
        return Err(GraphError::Invalid(format!(
            "stage `{}`: record `{}` has no shader-visible fields",
            stage.name, record.name
        )));
    }

    Ok(LayoutDesc {
        name: format!("{}/{}", record.name, stage.name),
        preset_id: 1,
        record_size: record.record_size,
        alignment: 4,
        fields,
    })
}

/// Resolve one `emit_quad` input to `(semantic, scale)`.
///
/// The input is either a plain `load_field`, or a `mul` of one by a
/// `const_f32`. Those are the only two shapes this lowering knows, and naming
/// that limit is the point: a graph that multiplies two fields, or scales by
/// something the CPU does not have, is `-ENOSYS` rather than a guess.
fn resolve_role(
    stage: &Stage,
    record: &crate::pipeline::RecordDef,
    id: u16,
    role: Semantic,
) -> Result<(Semantic, Option<f32>)> {
    let node = stage.nodes.iter().find(|n| n.id == id).ok_or_else(|| {
        GraphError::Invalid(format!(
            "stage `{}`: emit_quad input {} names no node",
            stage.name, id
        ))
    })?;

    let (field_node, scale) = if node.op == "mul" {
        // mul(load_field, const_f32). The constant may be either operand; a
        // graph should not have to remember an ordering the algebra does not.
        let mut field_node = None;
        let mut constant = None;
        for input in &node.inputs {
            let operand = stage.nodes.iter().find(|n| n.id == *input).ok_or_else(|| {
                GraphError::Invalid(format!(
                    "stage `{}`: mul input {} names no node",
                    stage.name, input
                ))
            })?;
            match operand.op.as_str() {
                "load_field" => field_node = Some(operand),
                "const_f32" => constant = Some(operand),
                other => {
                    return Err(GraphError::Unsupported(format!(
                        "stage `{}`: mul operand {} is `{}`; this lowering multiplies a field by \
                         a constant and nothing else",
                        stage.name, input, other
                    )))
                }
            }
        }
        let field_node = field_node.ok_or_else(|| {
            GraphError::Unsupported(format!(
                "stage `{}`: mul {} has no load_field operand",
                stage.name, id
            ))
        })?;
        let constant = constant.ok_or_else(|| {
            GraphError::Unsupported(format!(
                "stage `{}`: mul {} has no const_f32 operand",
                stage.name, id
            ))
        })?;
        (field_node, Some(const_f32(constant)?))
    } else {
        (node, None)
    };

    if field_node.op != "load_field" {
        return Err(GraphError::Unsupported(format!(
            "stage `{}`: emit_quad input {} is `{}`, this lowering expects `load_field` for {:?}",
            stage.name, id, field_node.op, role
        )));
    }
    let field = record.fields.get(usize::from(field_node.args[0])).ok_or_else(|| {
        GraphError::Invalid(format!(
            "stage `{}`: input {} names field {} which the record does not have",
            stage.name, id, field_node.args[0]
        ))
    })?;
    if field.semantic != role {
        return Err(GraphError::Unsupported(format!(
            "stage `{}`: emit_quad input {} (field `{}`) plays the role {:?}, but the field is {:?}",
            stage.name, id, field.name, role, field.semantic
        )));
    }
    Ok((field.semantic, scale))
}

/// Read a `const_f32` node's payload: two u16 halves, little-endian.
fn const_f32(node: &crate::pipeline::Node) -> Result<f32> {
    if node.args.len() != 2 {
        return Err(GraphError::Invalid(format!(
            "const_f32 node {}: {} args, expected 2",
            node.id,
            node.args.len()
        )));
    }
    let bits = u32::from(node.args[0]) | (u32::from(node.args[1]) << 16);
    Ok(f32::from_bits(bits))
}

/// The roles `emit_quad`'s first six inputs play, in order.
const EMIT_ROLES: [Semantic; 6] = [
    Semantic::PosX,
    Semantic::PosY,
    Semantic::W,
    Semantic::H,
    Semantic::SrcX,
    Semantic::SrcY,
];

/// Resolve every `emit_quad` input, returning `(role, scale)` per role and
/// checking the seventh input is the permutation.
fn resolve_emit(graph: &Graph, stage: &Stage) -> Result<[(Semantic, Option<f32>); 6]> {
    let record = graph
        .records
        .get(usize::from(stage.record_ref))
        .ok_or_else(|| GraphError::Invalid("record_ref out of range".to_string()))?;

    let emit_id = *stage
        .emits
        .first()
        .ok_or_else(|| GraphError::Invalid(format!("stage `{}`: no emitter", stage.name)))?;
    let emit = stage.nodes.iter().find(|n| n.id == emit_id).ok_or_else(|| {
        GraphError::Invalid(format!("stage `{}`: emitter {} names no node", stage.name, emit_id))
    })?;

    if emit.inputs.len() != 7 {
        return Err(GraphError::Unsupported(format!(
            "stage `{}`: emit_quad has {} inputs, this lowering emits exactly 7",
            stage.name,
            emit.inputs.len()
        )));
    }

    let mut roles = [(Semantic::PosX, None); 6];
    for (i, role) in EMIT_ROLES.iter().enumerate() {
        roles[i] = resolve_role(stage, record, emit.inputs[i], *role)?;
    }

    let perm = emit.inputs[6];
    let perm_node = stage.nodes.iter().find(|n| n.id == perm).ok_or_else(|| {
        GraphError::Invalid(format!("stage `{}`: no node {}", stage.name, perm))
    })?;
    if perm_node.op != "sort_by" {
        return Err(GraphError::Unsupported(format!(
            "stage `{}`: the seventh emit_quad input is `{}`, this lowering expects `sort_by`",
            stage.name, perm_node.op
        )));
    }
    Ok(roles)
}

/// Apply the graph's scales to the source `tension-shadergen` produced.
///
/// # Why a rewrite rather than a parameter
///
/// The generator takes a `LayoutDesc` and has no notion of arithmetic over its
/// fields — deliberately, because its job is a layout, not an expression. Its
/// API is fixed (the graph compiler *calls* it, per DESIGN.md §6.5), so the
/// scale is applied here, to the local the generator declared for that field.
///
/// This is a seam, and it is a narrow one: it rewrites exactly one declaration
/// per scaled role, and it **fails closed**. If the declaration it expects is
/// not present, the graph is refused rather than emitted unscaled — a silently
/// ignored multiplier would render the wrong thing while every other check
/// passed.
fn apply_scales(source: &str, roles: &[(Semantic, Option<f32>)], stage: &Stage) -> Result<String> {
    let mut out = source.to_string();
    for (semantic, scale) in roles {
        let Some(scale) = scale else { continue };
        // The name `generate_vertex` gives the local for this field: the
        // vocabulary's name for its slot, then the role suffix.
        let base = match semantic {
            Semantic::PosX | Semantic::PosY | Semantic::W | Semantic::H => "a_position",
            Semantic::SrcX | Semantic::SrcY => "a_texcoord0",
            other => {
                return Err(GraphError::Unsupported(format!(
                    "stage `{}`: cannot scale {:?}; this lowering scales the quad's geometry",
                    stage.name, other
                )))
            }
        };
        let suffix = match semantic {
            Semantic::PosX => "x",
            Semantic::PosY => "y",
            Semantic::W => "w",
            Semantic::H => "h",
            Semantic::SrcX => "x",
            Semantic::SrcY => "y",
            _ => unreachable!("filtered above"),
        };
        let local = format!("{base}_{suffix}");

        let needle = format!("    float {local} = ");
        let Some(line_start) = out.find(&needle) else {
            return Err(GraphError::Unsupported(format!(
                "stage `{}`: the generator did not declare `{local}`, so the graph's scale on \
                 {:?} cannot be applied",
                stage.name, semantic
            )));
        };
        let line_end = out[line_start..]
            .find(";\n")
            .map(|offset| line_start + offset)
            .ok_or_else(|| {
                GraphError::Unsupported(format!(
                    "stage `{}`: could not find the end of `{local}`'s declaration",
                    stage.name
                ))
            })?;

        let literal = float_literal(*scale);
        out.replace_range(line_end..line_end, &format!(" * {literal}"));
    }
    Ok(out)
}

/// A GLSL float literal that always has a decimal point: `2` alone is an int
/// literal in GLSL and `2 * float` is still fine, but `2` where a float is
/// expected reads as a type error to a human reviewing the emitted source.
fn float_literal(value: f32) -> String {
    if value.fract() == 0.0 && value.abs() < 1e7 {
        format!("{value:.1}")
    } else {
        format!("{value}")
    }
}

/// Lower a stage to GLSL.
pub fn lower(graph: &Graph, stage: &Stage) -> Result<Lowered> {
    let roles = resolve_emit(graph, stage)?;
    let layout = layout_for(graph, stage)?;

    let generated = generate_vertex(&layout, &NeutralVocabulary)
        .map_err(|e| GraphError::Unsupported(format!("shader generator (vertex): {e:?}")))?;
    let vertex = apply_scales(&generated, &roles, stage)?;
    let fragment = generate_fragment(&layout, &FragmentOptions::default())
        .map_err(|e| GraphError::Unsupported(format!("shader generator (fragment): {e:?}")))?;

    Ok(Lowered { vertex, fragment, layout })
}

/// The keys a stage sorts by: follow `emit_quad` -> `sort_by` ->
/// `make_tuple` -> `load_field`s, and read each field's offset and dtype.
///
/// This is the graph's comparator spec, and the input to the Cranelift
/// lowering. Reading it from the graph rather than assuming the triple is what
/// makes the CPU side graph-driven.
pub fn sort_keys(graph: &Graph, stage: &Stage) -> Result<Vec<super::cranelift_backend::Key>> {
    let record = graph
        .records
        .get(usize::from(stage.record_ref))
        .ok_or_else(|| GraphError::Invalid("record_ref out of range".to_string()))?;

    let emit = stage
        .nodes
        .iter()
        .find(|n| stage.emits.contains(&n.id))
        .ok_or_else(|| GraphError::Invalid("no emitter".to_string()))?;
    let perm = emit
        .inputs
        .last()
        .ok_or_else(|| GraphError::Invalid("emit_quad has no inputs".to_string()))?;
    let sort = stage
        .nodes
        .iter()
        .find(|n| n.id == *perm)
        .ok_or_else(|| GraphError::Invalid("no sort node".to_string()))?;
    let tuple_id = *sort
        .inputs
        .first()
        .ok_or_else(|| GraphError::Invalid("sort_by has no key".to_string()))?;
    let tuple = stage
        .nodes
        .iter()
        .find(|n| n.id == tuple_id)
        .ok_or_else(|| GraphError::Invalid("no tuple node".to_string()))?;

    let mut keys = Vec::new();
    for input in &tuple.inputs {
        let node = stage
            .nodes
            .iter()
            .find(|n| n.id == *input)
            .ok_or_else(|| GraphError::Invalid(format!("tuple input {input} names no node")))?;

        // A key is `load_field`, or `mul(load_field, const_f32)`. The scaled
        // form exists so a graph can order by a derived quantity without the
        // CPU side needing to know what the quantity means.
        let (field_node, scale) = if node.op == "mul" {
            let mut field_node = None;
            let mut constant = None;
            for operand in &node.inputs {
                let n = stage.nodes.iter().find(|n| n.id == *operand).ok_or_else(|| {
                    GraphError::Invalid(format!("mul input {operand} names no node"))
                })?;
                match n.op.as_str() {
                    "load_field" => field_node = Some(n),
                    "const_f32" => constant = Some(n),
                    other => {
                        return Err(GraphError::Unsupported(format!(
                            "sort key operand `{other}`: this lowering sorts by a field or a \
                             scaled field"
                        )))
                    }
                }
            }
            let field_node = field_node.ok_or_else(|| {
                GraphError::Unsupported("sort key mul has no load_field operand".to_string())
            })?;
            let constant = constant.ok_or_else(|| {
                GraphError::Unsupported("sort key mul has no const_f32 operand".to_string())
            })?;
            (field_node, Some(const_f32(constant)?))
        } else if node.op == "load_field" {
            (node, None)
        } else {
            return Err(GraphError::Unsupported(format!(
                "sort key input {input} is `{}`, this lowering sorts by record fields only",
                node.op
            )));
        };

        let field = record
            .fields
            .get(usize::from(field_node.args[0]))
            .ok_or_else(|| GraphError::Invalid("sort key field index out of range".to_string()))?;
        if scale.is_some() && field.dtype != DType::F32 {
            return Err(GraphError::Unsupported(format!(
                "sort key on `{}`: scaling a {:?} key is not a float multiply",
                field.name, field.dtype
            )));
        }
        keys.push(super::cranelift_backend::Key {
            offset: field.offset,
            dtype: field.dtype,
            scale,
        });
    }
    Ok(keys)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pipeline::parser::parse;
    use crate::pipeline_default::serialize_default_2d;

    fn default_graph() -> Graph {
        parse(&serialize_default_2d()).expect("parse")
    }

    #[test]
    fn the_graph_lowers_to_the_same_layout_the_preset_uses() {
        let graph = default_graph();
        let lowered = lower(&graph, &graph.stages[0]).expect("lower");
        // The generator's own `sprite_layout()` is what the hardcoded preset
        // path builds. If the graph's lowering produces a different layout, the
        // two paths cannot be byte-identical.
        let preset = tension_shadergen::sprite_layout();
        assert_eq!(lowered.layout.record_size, preset.record_size);
        assert_eq!(lowered.layout.alignment, preset.alignment);
        assert_eq!(lowered.layout.fields, preset.fields);
    }

    #[test]
    fn the_sort_keys_come_from_the_graph() {
        let graph = default_graph();
        let keys = sort_keys(&graph, &graph.stages[0]).expect("keys");
        assert_eq!(keys.len(), 3);
        assert_eq!(keys[0].offset, 20); // sort_key
        assert_eq!(keys[1].offset, 24); // group_id
        assert_eq!(keys[2].offset, 26); // z
    }

    #[test]
    fn the_scaled_graph_doubles_w_and_h_in_the_shader() {
        let graph = crate::pipeline_default::scaled_graph();
        let lowered = lower(&graph, &graph.stages[0]).expect("lower");

        // The generator cannot emit this itself: its quad is `corner * w`.
        // The multiply is the graph's, applied to the local it declared.
        assert!(
            lowered.vertex.contains("float a_position_w = float((r_words[base + 3u] >> 0u) & 0xFFFFu) * 2.0;"),
            "w is not doubled:\n{}",
            lowered.vertex
        );
        assert!(
            lowered.vertex.contains("float a_position_h = float((r_words[base + 3u] >> 16u) & 0xFFFFu) * 2.0;"),
            "h is not doubled:\n{}",
            lowered.vertex
        );
        // And nothing else moved.
        assert!(lowered.vertex.contains("float a_position_x = float(int(r_words[base + 0u]));"));
        assert!(lowered.vertex.contains("vec2 px = vec2(a_position_x + corner.x * a_position_w,"));
    }

    #[test]
    fn the_unscaled_graph_emits_no_multiplier() {
        let graph = default_graph();
        let lowered = lower(&graph, &graph.stages[0]).expect("lower");
        assert!(!lowered.vertex.contains(" * 2.0"), "a scale leaked into default_2d");
    }

    #[test]
    fn a_mul_of_two_fields_is_unsupported() {
        let mut graph = crate::pipeline_default::scaled_graph();
        let stage = &mut graph.stages[0];
        // mul(3, 14) -> mul(3, 4): two fields, which this lowering cannot emit.
        let mul = stage.nodes.iter().position(|n| n.id == 15).unwrap();
        stage.nodes[mul].inputs = vec![3, 4];
        assert!(matches!(lower(&graph, &graph.stages[0]), Err(GraphError::Unsupported(_))));
    }

    #[test]
    fn a_mis_wired_emit_is_unsupported() {
        let mut graph = default_graph();
        let stage = &mut graph.stages[0];
        let emit = stage.nodes.iter().position(|n| n.id == 13).unwrap();
        // Swap x and w: the lowering must refuse rather than silently emit the
        // roles it assumed.
        stage.nodes[emit].inputs.swap(0, 2);
        assert!(matches!(lower(&graph, &graph.stages[0]), Err(GraphError::Unsupported(_))));
    }
}
