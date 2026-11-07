//! Graph validation, before any lowering.
//!
//! The rule the whole module exists for: **nothing is lowered that has not been
//! checked**. A lowering that meets a dangling input has to panic or invent a
//! value, and both are worse than a refusal at the boundary.
//!
//! The checks, in the order they run:
//!
//! 1. shapes — at least one stage, each stage's `record_ref` in range;
//! 2. node identity — ids unique within a stage;
//! 3. the primitive library — every op name known, arity and result type right;
//! 4. references — every `input` names a node in this stage, every field index
//!    names a field of this stage's record;
//! 5. acyclicity — the input edges form a DAG;
//! 6. termination — every stage names at least one `emit_quad`, and every named
//!    emitter is one.

use std::collections::{HashMap, HashSet};

use super::{Graph, GraphError, Node, Result, Semantic, Stage, Type};

/// One primitive in the library the translator dispatches on.
///
/// Names, not opcodes: an unknown name is a clear `-ENOSYS` that says what was
/// asked for, where an unknown integer would be indistinguishable from a
/// mistyped one.
pub struct Primitive {
    pub name: &'static str,
    /// Inclusive input-count bounds.
    pub inputs: (usize, usize),
    /// Inclusive argument-count bounds.
    pub args: (usize, usize),
    /// The result types this primitive may declare.
    pub out_types: &'static [Type],
}

/// The op library. Deliberately short: only what `default_2d` needs.
///
/// Adding a primitive is adding a row here plus a case in each lowering that
/// consumes it — which is exactly the moment to ask whether the graph language
/// needs it or the design is growing an enum in disguise.
pub const PRIMITIVES: &[Primitive] = &[
    Primitive {
        name: "load_field",
        inputs: (0, 0),
        args: (1, 1),
        out_types: &[Type::F32, Type::U32],
    },
    Primitive {
        name: "parallax_offset",
        inputs: (0, 0),
        args: (1, 1),
        out_types: &[Type::Vec2],
    },
    Primitive {
        // Two args, not one: the payload is the f32's IEEE-754 bit pattern as
        // its low and high u16 halves, because `args` is a `Vec<u16>` and
        // rounding a constant through 8.8 fixed point would make `0.1` not
        // `0.1`. Little-endian, matching every other integer on this wire.
        name: "const_f32",
        inputs: (0, 0),
        args: (2, 2),
        out_types: &[Type::F32],
    },
    Primitive {
        name: "mul",
        inputs: (2, 2),
        args: (0, 0),
        out_types: &[Type::F32],
    },
    Primitive {
        name: "make_tuple",
        inputs: (1, 16),
        args: (0, 0),
        out_types: &[Type::Tuple],
    },
    Primitive {
        name: "sort_by",
        inputs: (1, 1),
        args: (0, 0),
        out_types: &[Type::Perm],
    },
    Primitive {
        name: "emit_quad",
        // x, y, w, h, src_x, src_y, and the permutation.
        inputs: (7, 7),
        args: (0, 0),
        out_types: &[Type::Void],
    },
];

fn primitive(name: &str) -> Option<&'static Primitive> {
    PRIMITIVES.iter().find(|p| p.name == name)
}

pub fn validate(graph: &Graph) -> Result<()> {
    if graph.stages.is_empty() {
        return Err(GraphError::Invalid("no stages".to_string()));
    }

    for stage in &graph.stages {
        validate_stage(graph, stage)?;
    }
    Ok(())
}

fn validate_stage(graph: &Graph, stage: &Stage) -> Result<()> {
    let record_index = usize::from(stage.record_ref);
    let record = graph.records.get(record_index).ok_or_else(|| {
        GraphError::Invalid(format!(
            "stage `{}`: record_ref {} names no RECORD ({} present)",
            stage.name,
            stage.record_ref,
            graph.records.len()
        ))
    })?;

    if stage.canvas.0 == 0 || stage.canvas.1 == 0 {
        return Err(GraphError::Invalid(format!(
            "stage `{}`: zero canvas",
            stage.name
        )));
    }

    // Node identity.
    let mut seen: HashSet<u16> = HashSet::new();
    for node in &stage.nodes {
        if !seen.insert(node.id) {
            return Err(GraphError::Invalid(format!(
                "stage `{}`: node id {} declared twice",
                stage.name, node.id
            )));
        }
    }

    // The primitive library, arity, result type.
    for node in &stage.nodes {
        let p = primitive(&node.op).ok_or_else(|| {
            GraphError::Unsupported(format!(
                "stage `{}` node {}: unknown primitive `{}`",
                stage.name, node.id, node.op
            ))
        })?;
        if node.inputs.len() < p.inputs.0 || node.inputs.len() > p.inputs.1 {
            return Err(GraphError::Invalid(format!(
                "stage `{}` node {} (`{}`): {} inputs, expected {}..={}",
                stage.name,
                node.id,
                p.name,
                node.inputs.len(),
                p.inputs.0,
                p.inputs.1
            )));
        }
        if node.args.len() < p.args.0 || node.args.len() > p.args.1 {
            return Err(GraphError::Invalid(format!(
                "stage `{}` node {} (`{}`): {} args, expected {}..={}",
                stage.name,
                node.id,
                p.name,
                node.args.len(),
                p.args.0,
                p.args.1
            )));
        }
        if !p.out_types.contains(&node.out_type) {
            return Err(GraphError::Invalid(format!(
                "stage `{}` node {} (`{}`): result type {:?} is not one of {:?}",
                stage.name, node.id, p.name, node.out_type, p.out_types
            )));
        }
    }

    let by_id: HashMap<u16, &Node> = stage.nodes.iter().map(|n| (n.id, n)).collect();

    for node in &stage.nodes {
        // Inputs exist and are not self-references.
        for input in &node.inputs {
            if *input == node.id {
                return Err(GraphError::Invalid(format!(
                    "stage `{}` node {}: consumes itself",
                    stage.name, node.id
                )));
            }
            if !by_id.contains_key(input) {
                return Err(GraphError::Invalid(format!(
                    "stage `{}` node {}: input {} names no node",
                    stage.name, node.id, input
                )));
            }
        }

        // Field references resolve to a real field of this stage's record.
        if node.op == "load_field" {
            let index = usize::from(node.args[0]);
            let field = record.fields.get(index).ok_or_else(|| {
                GraphError::Invalid(format!(
                    "stage `{}` node {}: field index {} names no field of RECORD `{}` ({} present)",
                    stage.name,
                    node.id,
                    index,
                    record.name,
                    record.fields.len()
                ))
            })?;
            // A padding slot has no value to load.
            if field.semantic == Semantic::Pad {
                return Err(GraphError::Invalid(format!(
                    "stage `{}` node {}: field `{}` is padding",
                    stage.name, node.id, field.name
                )));
            }
            let end = u32::from(field.offset) + u32::from(field.dtype.width());
            if end > u32::from(record.record_size) {
                return Err(GraphError::Invalid(format!(
                    "stage `{}` node {}: field `{}` ends at {} past record size {}",
                    stage.name, node.id, field.name, end, record.record_size
                )));
            }
        }
    }

    // Acyclicity: the input edges must form a DAG. Iterative colouring, so a
    // deep graph cannot blow the stack.
    let mut state: HashMap<u16, u8> = HashMap::new(); // 1 = visiting, 2 = done
    for node in &stage.nodes {
        if state.get(&node.id).copied() == Some(2) {
            continue;
        }
        let mut stack: Vec<(u16, usize)> = vec![(node.id, 0)];
        while let Some((id, cursor)) = stack.pop() {
            if cursor == 0 {
                match state.get(&id).copied() {
                    Some(1) => {
                        return Err(GraphError::Invalid(format!(
                            "stage `{}`: cycle through node {}",
                            stage.name, id
                        )))
                    }
                    Some(2) => continue,
                    _ => {
                        state.insert(id, 1);
                    }
                }
            }
            let current = by_id.get(&id).expect("checked above");
            if cursor < current.inputs.len() {
                stack.push((id, cursor + 1));
                let next = current.inputs[cursor];
                if state.get(&next).copied() == Some(1) {
                    return Err(GraphError::Invalid(format!(
                        "stage `{}`: cycle through node {}",
                        stage.name, next
                    )));
                }
                stack.push((next, 0));
            } else {
                state.insert(id, 2);
            }
        }
    }

    // Termination.
    if stage.emits.is_empty() {
        return Err(GraphError::Invalid(format!(
            "stage `{}`: no emitter, so it would draw nothing",
            stage.name
        )));
    }
    for emit in &stage.emits {
        let node = by_id.get(emit).ok_or_else(|| {
            GraphError::Invalid(format!(
                "stage `{}`: emitter {} names no node",
                stage.name, emit
            ))
        })?;
        if node.op != "emit_quad" {
            return Err(GraphError::Invalid(format!(
                "stage `{}`: emitter {} is `{}`, not `emit_quad`",
                stage.name, emit, node.op
            )));
        }
        if node.inputs.is_empty() {
            return Err(GraphError::Invalid(format!(
                "stage `{}`: emitter {} has no inputs, so it has nothing to draw",
                stage.name, emit
            )));
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pipeline::parser::parse;
    use crate::pipeline_default::serialize_default_2d;

    fn default_graph() -> Graph {
        parse(&serialize_default_2d()).expect("serializer output parses")
    }

    #[test]
    fn default_2d_validates() {
        validate(&default_graph()).expect("default_2d must validate");
    }

    #[test]
    fn a_dangling_input_is_invalid() {
        let mut graph = default_graph();
        graph.stages[0].nodes[0].inputs.push(99);
        assert!(matches!(validate(&graph), Err(GraphError::Invalid(_))));
    }

    #[test]
    fn a_field_index_out_of_range_is_invalid() {
        let mut graph = default_graph();
        // node 1 is load_field(x) with arg 0
        graph.stages[0].nodes[0].args[0] = 200;
        let err = validate(&graph).unwrap_err();
        assert!(matches!(err, GraphError::Invalid(_)), "{err}");
    }

    #[test]
    fn a_cycle_is_invalid() {
        let mut graph = default_graph();
        // node 11 is make_tuple over 7,8,9; make node 12 (sort_by 11) feed 13,
        // then point 11 at 12's output by making 11 consume 12.
        let stage = &mut graph.stages[0];
        let node11 = stage.nodes.iter().position(|n| n.id == 11).unwrap();
        stage.nodes[node11].inputs = vec![12];
        let err = validate(&graph).unwrap_err();
        assert!(matches!(err, GraphError::Invalid(_)), "{err}");
        assert!(err.to_string().contains("cycle"), "{err}");
    }

    #[test]
    fn an_unknown_primitive_is_unsupported() {
        let mut graph = default_graph();
        graph.stages[0].nodes[0].op = "frobnicate".to_string();
        let err = validate(&graph).unwrap_err();
        assert!(matches!(err, GraphError::Unsupported(_)), "{err}");
        assert_eq!(err.errno(), -38);
    }

    #[test]
    fn a_stage_with_no_emitter_is_invalid() {
        let mut graph = default_graph();
        graph.stages[0].emits.clear();
        assert!(matches!(validate(&graph), Err(GraphError::Invalid(_))));
    }

    #[test]
    fn an_emitter_that_is_not_emit_quad_is_invalid() {
        let mut graph = default_graph();
        graph.stages[0].emits = vec![1];
        assert!(matches!(validate(&graph), Err(GraphError::Invalid(_))));
    }

    #[test]
    fn a_record_ref_out_of_range_is_invalid() {
        let mut graph = default_graph();
        graph.stages[0].record_ref = 7;
        assert!(matches!(validate(&graph), Err(GraphError::Invalid(_))));
    }
}
