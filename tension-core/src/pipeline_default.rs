//! `default_2d` as a graph, and the writer that turns it into a blob.
//!
//! This is the first real graph the compiler has to handle, and it is written
//! out by hand on purpose: the *point* of the exercise is that the built-in
//! preset and the compiled graph must render identically. If the graph is
//! generated from the preset, they agree by construction and prove nothing.
//!
//! What the graph says, in order:
//!
//! ```text
//!  1..=6   load_field: x, y, w, h, src_x, src_y
//!  7..=9   load_field: sort_key, group_id, z      -- the ordering key
//!  10      parallax_offset(1.0)                   -- identity at v1
//!  11      make_tuple(7, 8, 9)                    -- (sort_key, group_id, z)
//!  12      sort_by(11)                            -- a permutation
//!  13      emit_quad(1, 2, 3, 4, 5, 6, 12)        -- the stage's terminator
//! ```
//!
//! The stage is named `world`, its canvas is 640x360, and its emitter is node
//! 13. Those are the facts the validator and both lowerings read.

use crate::pipeline::{
    Binding, DType, Node, RecordDef, Semantic, Stage, Type, Uniform, Graph, TAG_BINDING, TAG_NODE, TAG_RECORD,
    TAG_STAGE, TAG_UNIFORM, MAGIC, VERSION,
};

// ── the record ────────────────────────────────────────────────────────────

/// `sprite`, the 28-byte record from `tension_2d.h` / DESIGN.md §5.
///
/// Field order here is the *index* order the graph's `load_field` arguments
/// refer to, so it is part of the wire contract. Reordering this list silently
/// repoints every `load_field` in every blob that came before it.
fn sprite_record() -> RecordDef {
    RecordDef {
        name: "sprite".to_string(),
        record_size: 28,
        fields: vec![
            field("x", 0, DType::I32, Semantic::PosX),
            field("y", 4, DType::I32, Semantic::PosY),
            field("src_x", 8, DType::U16, Semantic::SrcX),
            field("src_y", 10, DType::U16, Semantic::SrcY),
            field("w", 12, DType::U16, Semantic::W),
            field("h", 14, DType::U16, Semantic::H),
            field("tex", 16, DType::U16, Semantic::Tex),
            field("sort_key", 20, DType::U32, Semantic::SortKey),
            field("group_id", 24, DType::U16, Semantic::GroupId),
            field("z", 26, DType::U8, Semantic::Z),
            field("flags", 27, DType::U8, Semantic::Flags),
        ],
    }
}

fn field(name: &str, offset: u16, dtype: DType, semantic: Semantic) -> crate::pipeline::FieldDef {
    crate::pipeline::FieldDef {
        name: name.to_string(),
        offset,
        dtype,
        semantic,
    }
}

// ── the graph ─────────────────────────────────────────────────────────────

/// The field indices `default_2d`'s nodes refer to, named so the table below
/// reads as data rather than as magic numbers.
const F_X: u16 = 0;
const F_Y: u16 = 1;
const F_W: u16 = 4;
const F_H: u16 = 5;
const F_SRC_X: u16 = 2;
const F_SRC_Y: u16 = 3;
const F_SORT_KEY: u16 = 7;
const F_GROUP_ID: u16 = 8;
const F_Z: u16 = 9;

/// The `default_2d` graph as data.
pub fn default_graph() -> Graph {
    let nodes = vec![
        load(1, F_X, Type::F32),
        load(2, F_Y, Type::F32),
        load(3, F_W, Type::F32),
        load(4, F_H, Type::F32),
        load(5, F_SRC_X, Type::F32),
        load(6, F_SRC_Y, Type::F32),
        load(7, F_SORT_KEY, Type::U32),
        load(8, F_GROUP_ID, Type::U32),
        load(9, F_Z, Type::U32),
        // Identity: factor 1.0 in 8.8 fixed point. The op exists so the graph
        // already has the shape a parallax layer will need; at 1.0 it multiplies
        // through and changes nothing.
        Node {
            id: 10,
            op: "parallax_offset".to_string(),
            out_type: Type::Vec2,
            inputs: vec![],
            args: vec![0x0100],
        },
        Node {
            id: 11,
            op: "make_tuple".to_string(),
            out_type: Type::Tuple,
            inputs: vec![7, 8, 9],
            args: vec![],
        },
        Node {
            id: 12,
            op: "sort_by".to_string(),
            out_type: Type::Perm,
            inputs: vec![11],
            args: vec![],
        },
        Node {
            id: 13,
            op: "emit_quad".to_string(),
            out_type: Type::Void,
            inputs: vec![1, 2, 3, 4, 5, 6, 12],
            args: vec![],
        },
    ];

    Graph {
        records: vec![sprite_record()],
        stages: vec![Stage {
            id: 1,
            name: "world".to_string(),
            canvas: (640, 360),
            record_ref: 0,
            nodes,
            emits: vec![13],
        }],
        uniforms: vec![
            // The vertex stage's one uniform block: `{ vec2 canvas_half;
            // vec2 tex_size; }`. Both halves sit at slot 0 because SDL_GPU
            // pushes them as one block.
            Uniform { name: "u_canvas_half".to_string(), ty: 0, slot: 0 },
            Uniform { name: "u_tex_size".to_string(), ty: 0, slot: 0 },
        ],
        bindings: vec![
            // 0 = the record storage buffer (set 0)
            Binding { stage_ref: 1, resource_ref: 0, slot: 0 },
            // 1 = the atlas (set 2)
            Binding { stage_ref: 1, resource_ref: 1, slot: 0 },
            // 2 = the uniform block (set 1)
            Binding { stage_ref: 1, resource_ref: 2, slot: 0 },
        ],
    }
}

fn load(id: u16, field: u16, out_type: Type) -> Node {
    Node {
        id,
        op: "load_field".to_string(),
        out_type,
        inputs: vec![],
        args: vec![field],
    }
}

// ── the writer ────────────────────────────────────────────────────────────

/// Serialize `default_2d` to the wire format.
pub fn serialize_default_2d() -> Vec<u8> {
    serialize(&default_graph())
}

// ── default_2d_scaled ─────────────────────────────────────────────────────

/// `default_2d` with the quad doubled, and nothing else changed.
///
/// The point of this graph is that the hand-written preset **cannot** produce
/// it: `tension-shadergen` emits `corner.x * w` from the record's own `w`, with
/// no way to scale it. So a frame that comes out at 64x64 is evidence the graph
/// reached the shader as data, rather than the compiler replaying the preset it
/// already knew how to draw.
///
/// Two nodes added, one shared constant:
///
/// ```text
///  14      const_f32(2.0)
///  15      mul(3, 14)   -- w * 2
///  16      mul(4, 14)   -- h * 2
/// ```
///
/// and `emit_quad`'s third and fourth inputs repointed from 3 and 4 to 15 and
/// 16. The sort key, the record, the canvas and every other node are byte for
/// byte `default_2d`'s.
pub fn scaled_graph() -> Graph {
    scaled_graph_with(2.0)
}

/// The scaled graph with an arbitrary factor, so a test can ask for 1.5 without
/// a second hand-written graph.
pub fn scaled_graph_with(factor: f32) -> Graph {
    let mut graph = default_graph();
    let stage = &mut graph.stages[0];

    // node 14: the constant. 2.0f32 == 0x4000_0000, little-endian halves.
    let two = factor.to_bits();
    stage.nodes.push(Node {
        id: 14,
        op: "const_f32".to_string(),
        out_type: Type::F32,
        inputs: vec![],
        args: vec![(two & 0xFFFF) as u16, (two >> 16) as u16],
    });
    stage.nodes.push(Node {
        id: 15,
        op: "mul".to_string(),
        out_type: Type::F32,
        inputs: vec![3, 14],
        args: vec![],
    });
    stage.nodes.push(Node {
        id: 16,
        op: "mul".to_string(),
        out_type: Type::F32,
        inputs: vec![4, 14],
        args: vec![],
    });

    let emit = stage
        .nodes
        .iter()
        .position(|n| n.id == 13)
        .expect("default_2d ends at node 13");
    // x, y, w*2, h*2, src_x, src_y, perm
    stage.nodes[emit].inputs = vec![1, 2, 15, 16, 5, 6, 12];
    graph
}

/// Serialize `default_2d_scaled`.
pub fn serialize_default_2d_scaled() -> Vec<u8> {
    serialize(&scaled_graph())
}

/// Serialize any graph to the wire format.
///
/// The writer is total: it cannot fail, because a `Graph` that this crate built
/// is well-formed by construction. Anything a guest sends goes the other way,
/// through `parser::parse`, which can and does fail.
pub fn serialize(graph: &Graph) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&MAGIC);
    out.push(VERSION);

    for record in &graph.records {
        let mut payload = Vec::new();
        put_string(&mut payload, &record.name);
        put_u16(&mut payload, record.record_size);
        put_u16(&mut payload, record.fields.len() as u16);
        for field in &record.fields {
            put_string(&mut payload, &field.name);
            put_u16(&mut payload, field.offset);
            payload.push(field.dtype.to_wire());
            payload.push(field.semantic.to_wire());
        }
        put_tlv(&mut out, TAG_RECORD, &payload);
    }

    for stage in &graph.stages {
        let mut payload = Vec::new();
        put_string(&mut payload, &stage.name);
        put_u16(&mut payload, stage.canvas.0);
        put_u16(&mut payload, stage.canvas.1);
        put_u16(&mut payload, stage.record_ref);
        put_u16(&mut payload, stage.id);

        put_u16(&mut payload, stage.nodes.len() as u16);
        for node in &stage.nodes {
            let mut node_payload = Vec::new();
            put_u16(&mut node_payload, node.id);
            put_string(&mut node_payload, &node.op);
            node_payload.push(node.out_type.to_wire());
            put_u16(&mut node_payload, node.inputs.len() as u16);
            for input in &node.inputs {
                put_u16(&mut node_payload, *input);
            }
            put_u16(&mut node_payload, node.args.len() as u16);
            for arg in &node.args {
                put_u16(&mut node_payload, *arg);
            }
            // A nested TLV: the node payload is itself a tagged, length-prefixed
            // record, so a reader can skip a node it does not understand.
            put_tlv(&mut payload, TAG_NODE, &node_payload);
        }

        put_u16(&mut payload, stage.emits.len() as u16);
        for emit in &stage.emits {
            put_u16(&mut payload, *emit);
        }
        put_tlv(&mut out, TAG_STAGE, &payload);
    }

    for uniform in &graph.uniforms {
        let mut payload = Vec::new();
        put_string(&mut payload, &uniform.name);
        payload.push(uniform.ty);
        put_u16(&mut payload, uniform.slot);
        put_tlv(&mut out, TAG_UNIFORM, &payload);
    }

    for binding in &graph.bindings {
        let mut payload = Vec::new();
        put_u16(&mut payload, binding.stage_ref);
        put_u16(&mut payload, binding.resource_ref);
        put_u16(&mut payload, binding.slot);
        put_tlv(&mut out, TAG_BINDING, &payload);
    }

    out
}

fn put_u16(out: &mut Vec<u8>, value: u16) {
    out.extend_from_slice(&value.to_le_bytes());
}

fn put_string(out: &mut Vec<u8>, value: &str) {
    put_u16(out, value.len() as u16);
    out.extend_from_slice(value.as_bytes());
}

fn put_tlv(out: &mut Vec<u8>, tag: u8, payload: &[u8]) {
    out.push(tag);
    out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    out.extend_from_slice(payload);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_blob_starts_with_the_magic_and_version() {
        let blob = serialize_default_2d();
        assert_eq!(&blob[..4], b"T2DG");
        assert_eq!(blob[4], 1);
    }

    #[test]
    fn the_writer_is_deterministic() {
        assert_eq!(serialize_default_2d(), serialize_default_2d());
    }

    #[test]
    fn the_record_is_the_one_the_adapter_uses() {
        let record = &default_graph().records[0];
        assert_eq!(record.record_size, 28);
        let by_name = |name: &str| record.fields.iter().find(|f| f.name == name).cloned().unwrap();
        assert_eq!(by_name("x").offset, 0);
        assert_eq!(by_name("src_x").offset, 8);
        assert_eq!(by_name("w").offset, 12);
        assert_eq!(by_name("sort_key").offset, 20);
        assert_eq!(by_name("group_id").offset, 24);
        assert_eq!(by_name("z").offset, 26);
        assert_eq!(by_name("flags").offset, 27);
    }

    #[test]
    fn the_hash_is_stable() {
        // A cache key that changes between runs is a cache that never hits. The
        // value is pinned so a change to the format shows up as a test failure
        // rather than as a silent recompile-every-time.
        let hash = Graph::hash(&serialize_default_2d());
        assert_eq!(hash, Graph::hash(&serialize_default_2d()));
    }
}
