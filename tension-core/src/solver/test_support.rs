//! Test-side writer for the configuration wire (DESIGN.md §12).
//!
//! The framework is the format's writer (`tension-framework/assembly/solver.ts`);
//! the WAT fixtures the P5 and P8e tests instantiate cannot call
//! AssemblyScript, so this mirrors the encoder in Rust: the same layout, the
//! same rules — an 8-byte-aligned start, one 8-byte slot per set bit in bit
//! order, a length-prefixed UTF-8 string table in header-field order, and no
//! trailing byte. The fixtures embed the bytes it produces in a data segment
//! and pass `(ptr, len)` to the host.
//!
//! It is a *second* writer on purpose: these tests check the host's strict
//! reading of the spec, and the examples (`examples/solver/`,
//! `examples/world/`) are what prove the framework's encoder agrees with it.

const HEADER_LEN: usize = 64;

/// A config in the §12 layout, under construction.
pub struct Wire {
    method: String,
    source: String,
    description: Option<String>,
    world: Option<String>,
    dim: u32,
    params: [Option<f64>; 9],
}

impl Wire {
    pub fn new(method: &str, source: &str) -> Self {
        Self {
            method: method.to_owned(),
            source: source.to_owned(),
            description: None,
            world: None,
            dim: 0,
            params: [None; 9],
        }
    }

    pub fn dim(mut self, dim: u32) -> Self {
        self.dim = dim;
        self
    }

    pub fn description(mut self, text: &str) -> Self {
        self.description = Some(text.to_owned());
        self
    }

    pub fn world(mut self, yaml: &str) -> Self {
        self.world = Some(yaml.to_owned());
        self
    }

    /// State a parameter by its schema name (`relTol`, `absTol`, …). An
    /// unknown name is a test bug, so it panics.
    pub fn param(mut self, name: &str, value: f64) -> Self {
        let bit = match name {
            "relTol" => 0,
            "absTol" => 1,
            "minStep" => 2,
            "maxStep" => 3,
            "fixedStep" => 4,
            "iterations" => 5,
            "convergenceTol" => 6,
            "compliance" => 7,
            "relaxation" => 8,
            other => panic!("no such parameter: {other}"),
        };
        self.params[bit] = Some(value);
        self
    }

    /// The bitmap, with the nine bits set for the parameters present.
    pub fn bitmap(&self) -> u32 {
        let mut bits = 0u32;
        for (bit, value) in self.params.iter().enumerate() {
            if value.is_some() {
                bits |= 1 << bit;
            }
        }
        bits
    }

    /// The encoded blob.
    pub fn bytes(&self) -> Vec<u8> {
        let method = self.method.as_bytes();
        let source = self.source.as_bytes();
        let description = self.description.as_deref().map(str::as_bytes);
        let world = self.world.as_deref().map(str::as_bytes);
        let bitmap = self.bitmap();
        let slots = bitmap.count_ones() as usize;

        let mut off = HEADER_LEN + slots * 8;
        let method_off = off;
        off += 4 + method.len();
        let source_off = off;
        off += 4 + source.len();
        let description_off = description.map(|text| {
            let at = off;
            off += 4 + text.len();
            at
        });
        let world_off = world.map(|text| {
            let at = off;
            off += 4 + text.len();
            at
        });

        let mut bytes = vec![0u8; off];
        bytes[0..8].copy_from_slice(b"TNSCONF1");
        put_u16(&mut bytes, 8, 1); // format_version
        put_u16(&mut bytes, 10, 1); // schema_version
        put_u32(&mut bytes, 12, method_off as u32);
        put_u32(&mut bytes, 16, method.len() as u32);
        put_u32(&mut bytes, 20, source_off as u32);
        put_u32(&mut bytes, 24, source.len() as u32);
        put_u32(&mut bytes, 28, description_off.unwrap_or(0) as u32);
        put_u32(&mut bytes, 32, description.map_or(0, |t| t.len() as u32));
        put_u32(&mut bytes, 36, self.dim);
        put_u32(&mut bytes, 40, if bitmap == 0 { 0 } else { HEADER_LEN as u32 });
        put_u32(&mut bytes, 44, bitmap);
        put_u32(&mut bytes, 48, world_off.unwrap_or(0) as u32);
        put_u32(&mut bytes, 52, world.map_or(0, |t| t.len() as u32));
        // 56..64 stays zero (reserved).

        let mut slot = HEADER_LEN;
        for bit in 0..9usize {
            let Some(value) = self.params[bit] else { continue };
            if bit == 5 {
                // iterations: schema type u32, in the slot's low four bytes
                put_u32(&mut bytes, slot, value as u32);
            } else {
                bytes[slot..slot + 8].copy_from_slice(&value.to_le_bytes());
            }
            slot += 8;
        }

        put_entry(&mut bytes, method_off, method);
        put_entry(&mut bytes, source_off, source);
        if let (Some(at), Some(text)) = (description_off, description) {
            put_entry(&mut bytes, at, text);
        }
        if let (Some(at), Some(text)) = (world_off, world) {
            put_entry(&mut bytes, at, text);
        }
        bytes
    }

    pub fn len(&self) -> usize {
        self.bytes().len()
    }

    /// The blob as a WAT data-string literal: every byte hex-escaped, which
    /// keeps arbitrary bytes (the YAML's newlines, the magic) out of the
    /// literal's own syntax.
    pub fn wat(&self) -> String {
        let mut out = String::with_capacity(self.len() * 3);
        for byte in self.bytes() {
            out.push_str(&format!("\\{byte:02x}"));
        }
        out
    }
}

fn put_u16(bytes: &mut [u8], at: usize, value: u16) {
    bytes[at..at + 2].copy_from_slice(&value.to_le_bytes());
}

fn put_u32(bytes: &mut [u8], at: usize, value: u32) {
    bytes[at..at + 4].copy_from_slice(&value.to_le_bytes());
}

fn put_entry(bytes: &mut [u8], at: usize, text: &[u8]) {
    put_u32(bytes, at, text.len() as u32);
    bytes[at + 4..at + 4 + text.len()].copy_from_slice(text);
}
