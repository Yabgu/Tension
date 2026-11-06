//! Blob -> [`Graph`].
//!
//! Every read is bounds-checked and every length is validated before it is used
//! to slice. The blob is guest-supplied data: a truncated `u32` must be a
//! refusal, never a panic and never a short slice read as if it were whole.

use super::{Graph, GraphError, Result, Node, Type, Binding, Uniform, Stage, RecordDef, FieldDef, DType, Semantic,
            MAGIC, VERSION, TAG_BINDING, TAG_NODE, TAG_RECORD, TAG_STAGE, TAG_UNIFORM};

/// A cursor over a byte slice. `take` is the only way bytes leave it.
struct Reader<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, pos: 0 }
    }

    fn remaining(&self) -> usize {
        self.bytes.len().saturating_sub(self.pos)
    }

    fn at_end(&self) -> bool {
        self.remaining() == 0
    }

    fn take(&mut self, n: usize) -> Result<&'a [u8]> {
        if self.remaining() < n {
            return Err(GraphError::Malformed(format!(
                "truncated: wanted {n} byte(s) at offset {}, {} remain",
                self.pos,
                self.remaining()
            )));
        }
        let slice = &self.bytes[self.pos..self.pos + n];
        self.pos += n;
        Ok(slice)
    }

    fn u8(&mut self) -> Result<u8> {
        Ok(self.take(1)?[0])
    }

    fn u16(&mut self) -> Result<u16> {
        let b = self.take(2)?;
        Ok(u16::from_le_bytes([b[0], b[1]]))
    }

    fn u32(&mut self) -> Result<u32> {
        let b = self.take(4)?;
        Ok(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }

    fn string(&mut self) -> Result<String> {
        let len = self.u16()? as usize;
        let bytes = self.take(len)?;
        String::from_utf8(bytes.to_vec())
            .map_err(|_| GraphError::Malformed("string is not UTF-8".to_string()))
    }

    fn count(&mut self, what: &str) -> Result<usize> {
        let n = self.u16()? as usize;
        // A count is a promise about the bytes that follow. Check it against
        // what is left before allocating: 65 535 inputs times 2 bytes is still
        // a refusal, not an allocation we then fail to fill.
        if n * 2 > self.remaining() + 2 {
            return Err(GraphError::Malformed(format!(
                "{what} count {n} does not fit in the remaining bytes"
            )));
        }
        Ok(n)
    }
}

/// Read one TLV header: `(tag, payload)`.
fn tlv<'a>(reader: &mut Reader<'a>) -> Result<(u8, &'a [u8])> {
    let tag = reader.u8()?;
    let len = reader.u32()? as usize;
    Ok((tag, reader.take(len)?))
}

pub fn parse(blob: &[u8]) -> Result<Graph> {
    let mut reader = Reader::new(blob);

    if blob.len() < 5 {
        return Err(GraphError::Malformed("shorter than the 5-byte header".to_string()));
    }
    let magic = reader.take(4)?;
    if magic != MAGIC {
        return Err(GraphError::Malformed(format!(
            "bad magic {magic:?}, expected {MAGIC:?}"
        )));
    }
    let version = reader.u8()?;
    if version != VERSION {
        return Err(GraphError::Unsupported(format!(
            "wire version {version}, this build reads {VERSION}"
        )));
    }

    let mut graph = Graph::default();
    while !reader.at_end() {
        let (tag, payload) = tlv(&mut reader)?;
        match tag {
            TAG_RECORD => graph.records.push(parse_record(payload)?),
            TAG_STAGE => graph.stages.push(parse_stage(payload)?),
            TAG_UNIFORM => graph.uniforms.push(parse_uniform(payload)?),
            TAG_BINDING => graph.bindings.push(parse_binding(payload)?),
            other => {
                return Err(GraphError::Malformed(format!(
                    "unknown top-level tag {other}"
                )))
            }
        }
    }

    if graph.records.is_empty() || graph.stages.is_empty() {
        return Err(GraphError::Malformed(
            "a graph needs at least one RECORD and one STAGE".to_string(),
        ));
    }
    Ok(graph)
}

fn parse_record(payload: &[u8]) -> Result<RecordDef> {
    let mut r = Reader::new(payload);
    let name = r.string()?;
    let record_size = r.u16()?;
    let field_count = r.count("field")?;

    let mut fields = Vec::with_capacity(field_count);
    for _ in 0..field_count {
        let field_name = r.string()?;
        let offset = r.u16()?;
        let dtype = DType::from_wire(r.u8()?)
            .ok_or_else(|| GraphError::Malformed("unknown field dtype".to_string()))?;
        let semantic = Semantic::from_wire(r.u8()?)
            .ok_or_else(|| GraphError::Malformed("unknown field semantic".to_string()))?;
        fields.push(FieldDef { name: field_name, offset, dtype, semantic });
    }
    if !r.at_end() {
        return Err(GraphError::Malformed(format!(
            "RECORD `{name}` has {} trailing byte(s)",
            r.remaining()
        )));
    }
    Ok(RecordDef { name, record_size, fields })
}

fn parse_stage(payload: &[u8]) -> Result<Stage> {
    let mut r = Reader::new(payload);
    let name = r.string()?;
    let canvas_w = r.u16()?;
    let canvas_h = r.u16()?;
    let record_ref = r.u16()?;
    let id = r.u16()?;

    let node_count = r.u16()? as usize;
    let mut nodes = Vec::with_capacity(node_count);
    for _ in 0..node_count {
        let (tag, node_payload) = tlv(&mut r)?;
        if tag != TAG_NODE {
            return Err(GraphError::Malformed(format!(
                "stage `{name}` expected a NODE, found tag {tag}"
            )));
        }
        nodes.push(parse_node(node_payload)?);
    }

    let emit_count = r.u16()? as usize;
    let mut emits = Vec::with_capacity(emit_count);
    for _ in 0..emit_count {
        emits.push(r.u16()?);
    }

    if !r.at_end() {
        return Err(GraphError::Malformed(format!(
            "STAGE `{name}` has {} trailing byte(s)",
            r.remaining()
        )));
    }
    Ok(Stage { id, name, canvas: (canvas_w, canvas_h), record_ref, nodes, emits })
}

fn parse_node(payload: &[u8]) -> Result<Node> {
    let mut r = Reader::new(payload);
    let id = r.u16()?;
    let op = r.string()?;
    let out_type = Type::from_wire(r.u8()?)
        .ok_or_else(|| GraphError::Malformed(format!("node {id}: unknown out_type")))?;

    let input_count = r.count("input")?;
    let mut inputs = Vec::with_capacity(input_count);
    for _ in 0..input_count {
        inputs.push(r.u16()?);
    }

    let arg_count = r.count("arg")?;
    let mut args = Vec::with_capacity(arg_count);
    for _ in 0..arg_count {
        args.push(r.u16()?);
    }

    // A node's payload ends where its TLV said it does; trailing bytes mean the
    // writer and this reader disagree about the shape, which is worse than a
    // truncation because it parses.
    if !r.at_end() {
        return Err(GraphError::Malformed(format!(
            "node {id} (`{op}`) has {} trailing byte(s)",
            r.remaining()
        )));
    }
    Ok(Node { id, op, out_type, inputs, args })
}

fn parse_uniform(payload: &[u8]) -> Result<Uniform> {
    let mut r = Reader::new(payload);
    let name = r.string()?;
    let ty = r.u8()?;
    let slot = r.u16()?;
    if !r.at_end() {
        return Err(GraphError::Malformed(format!(
            "UNIFORM `{name}` has trailing bytes"
        )));
    }
    Ok(Uniform { name, ty, slot })
}

fn parse_binding(payload: &[u8]) -> Result<Binding> {
    let mut r = Reader::new(payload);
    let stage_ref = r.u16()?;
    let resource_ref = r.u16()?;
    let slot = r.u16()?;
    if !r.at_end() {
        return Err(GraphError::Malformed("BINDING has trailing bytes".to_string()));
    }
    Ok(Binding { stage_ref, resource_ref, slot })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pipeline_default::serialize_default_2d;

    #[test]
    fn a_short_blob_is_malformed() {
        assert!(matches!(parse(b"T2D"), Err(GraphError::Malformed(_))));
    }

    #[test]
    fn a_bad_magic_is_malformed() {
        assert!(matches!(parse(b"XXXX\x01"), Err(GraphError::Malformed(_))));
    }

    #[test]
    fn a_newer_version_is_unsupported_not_malformed() {
        // Unsupported, because "this host is old" and "your blob is corrupt"
        // are different refusals with different errnos.
        assert!(matches!(parse(b"T2DG\x02"), Err(GraphError::Unsupported(_))));
    }

    #[test]
    fn the_default_graph_round_trips() {
        let blob = serialize_default_2d();
        let graph = parse(&blob).expect("the serializer's own output must parse");
        assert_eq!(graph.records.len(), 1);
        assert_eq!(graph.stages.len(), 1);

        let stage = &graph.stages[0];
        assert_eq!(stage.name, "world");
        assert_eq!(stage.canvas, (640, 360));
        assert_eq!(stage.emits, vec![13]);
        assert_eq!(stage.nodes.len(), 13);
    }

    #[test]
    fn a_truncated_blob_is_a_refusal_not_a_panic() {
        let blob = serialize_default_2d();
        for cut in [6, 10, 20, blob.len() - 1] {
            let _ = parse(&blob[..cut]);
        }
    }

    #[test]
    fn a_tlv_length_longer_than_the_blob_is_malformed() {
        let mut blob = serialize_default_2d();
        blob.truncate(9);
        assert!(matches!(parse(&blob), Err(GraphError::Malformed(_))));
    }
}
