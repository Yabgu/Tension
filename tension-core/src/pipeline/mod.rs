//! The pipeline graph: a wire format, a validator, and two lowerings.
//!
//! A 2D pipeline — how records become vertices, how they are ordered, what the
//! fragment stage does — is data. The guest (or this crate, for the built-in
//! presets) hands over a serialized graph; the compiler parses it, checks it,
//! and lowers it to (a) GLSL for the GPU and (b) a native comparator for the
//! CPU sort.
//!
//! `docs/modules/2d.md` §4 is the argument. This module is the first slice of it: enough
//! to compile `default_2d` and produce pixels byte-identical to the
//! hand-written preset, and nothing more.
//!
//! # Why op names and not opcodes
//!
//! A guest sends `"sort_by"`, not `12`. An opcode table would have to be
//! versioned in lockstep with every producer, and an unknown integer is
//! indistinguishable from a mistyped one. An unknown *string* is a clear
//! `-ENOSYS` naming what was asked for, which is the difference between "this
//! host is old" and "your blob is corrupt".
//!
//! # The wire
//!
//! ```text
//! "T2DG"            magic, 4 bytes
//! u8                version (1)
//! repeated:         TLV
//!   u8     tag      1 = RECORD, 2 = STAGE, 3 = NODE (inside STAGE),
//!                   4 = UNIFORM, 5 = BINDING
//!   u32    len      payload length in bytes, little-endian
//!   [u8; len]       payload
//! ```
//!
//! Every integer is little-endian and fixed-width. Payloads are described by
//! the readers in [`parser`], which is the only place that knows them.

pub mod cranelift_backend;
pub mod glsl_backend;
pub mod naga_backend;
pub mod parser;
pub mod validate;

/// Magic bytes at the start of every graph blob.
pub const MAGIC: [u8; 4] = *b"T2DG";

/// The only wire version this build reads.
pub const VERSION: u8 = 1;

/// TLV tags.
pub const TAG_RECORD: u8 = 1;
pub const TAG_STAGE: u8 = 2;
pub const TAG_NODE: u8 = 3;
pub const TAG_UNIFORM: u8 = 4;
pub const TAG_BINDING: u8 = 5;

/// A field's wire type, matching `TENSION_DTYPE_*` in `tension_adapter.h`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DType {
    F32,
    U16,
    I16,
    U8,
    I32,
    /// Unsigned 32-bit. `sort_key` is a depth value and depth is naturally
    /// unsigned (`docs/modules/2d.md` §8), so the comparator must not treat it as signed.
    U32,
}

impl DType {
    pub fn from_wire(value: u8) -> Option<Self> {
        Some(match value {
            1 => DType::F32,
            2 => DType::U16,
            3 => DType::I16,
            4 => DType::U8,
            5 => DType::I32,
            6 => DType::U32,
            _ => return None,
        })
    }

    pub fn to_wire(self) -> u8 {
        match self {
            DType::F32 => 1,
            DType::U16 => 2,
            DType::I16 => 3,
            DType::U8 => 4,
            DType::I32 => 5,
            DType::U32 => 6,
        }
    }

    pub fn width(self) -> u16 {
        match self {
            DType::F32 | DType::I32 | DType::U32 => 4,
            DType::U16 | DType::I16 => 2,
            DType::U8 => 1,
        }
    }

    /// How a value is sign- or zero-extended when read as a 32-bit word.
    pub fn signed(self) -> bool {
        matches!(self, DType::I16 | DType::I32)
    }
}

/// A field's meaning, matching `TENSION_SEM_*`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Semantic {
    PosX,
    PosY,
    PosZ,
    SrcX,
    SrcY,
    SrcW,
    SrcH,
    UvX,
    UvY,
    W,
    H,
    Tint,
    SortKey,
    Pad,
    /// Not a `TENSION_SEM_*`: `group_id` and `z` are ordering fields the C
    /// header does not name, and the graph compiler needs to tell them apart
    /// from a plain pad. They extend the same closed list, so they are given
    /// codes past `TINT`/`SORT_KEY` rather than a second enum.
    GroupId,
    Z,
    Flags,
    Tex,
}

impl Semantic {
    pub fn from_wire(value: u8) -> Option<Self> {
        Some(match value {
            1 => Semantic::PosX,
            2 => Semantic::PosY,
            3 => Semantic::PosZ,
            4 => Semantic::SrcX,
            5 => Semantic::SrcY,
            6 => Semantic::SrcW,
            7 => Semantic::SrcH,
            8 => Semantic::UvX,
            9 => Semantic::UvY,
            10 => Semantic::W,
            11 => Semantic::H,
            12 => Semantic::Tint,
            13 => Semantic::SortKey,
            14 => Semantic::Pad,
            15 => Semantic::GroupId,
            16 => Semantic::Z,
            17 => Semantic::Flags,
            18 => Semantic::Tex,
            _ => return None,
        })
    }

    pub fn to_wire(self) -> u8 {
        match self {
            Semantic::PosX => 1,
            Semantic::PosY => 2,
            Semantic::PosZ => 3,
            Semantic::SrcX => 4,
            Semantic::SrcY => 5,
            Semantic::SrcW => 6,
            Semantic::SrcH => 7,
            Semantic::UvX => 8,
            Semantic::UvY => 9,
            Semantic::W => 10,
            Semantic::H => 11,
            Semantic::Tint => 12,
            Semantic::SortKey => 13,
            Semantic::Pad => 14,
            Semantic::GroupId => 15,
            Semantic::Z => 16,
            Semantic::Flags => 17,
            Semantic::Tex => 18,
        }
    }
}

/// A node's result type.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Type {
    Void,
    F32,
    U32,
    Vec2,
    Vec4,
    /// A comparator key: an ordered tuple of fields.
    Tuple,
    /// A permutation of a bucket's records.
    Perm,
    /// One record.
    Record,
}

impl Type {
    pub fn from_wire(value: u8) -> Option<Self> {
        Some(match value {
            0 => Type::Void,
            1 => Type::F32,
            2 => Type::U32,
            3 => Type::Vec2,
            4 => Type::Vec4,
            5 => Type::Tuple,
            6 => Type::Perm,
            7 => Type::Record,
            _ => return None,
        })
    }

    pub fn to_wire(self) -> u8 {
        match self {
            Type::Void => 0,
            Type::F32 => 1,
            Type::U32 => 2,
            Type::Vec2 => 3,
            Type::Vec4 => 4,
            Type::Tuple => 5,
            Type::Perm => 6,
            Type::Record => 7,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FieldDef {
    pub name: String,
    pub offset: u16,
    pub dtype: DType,
    pub semantic: Semantic,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecordDef {
    pub name: String,
    pub record_size: u16,
    pub fields: Vec<FieldDef>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Node {
    pub id: u16,
    /// The primitive's name — `"load_field"`, `"sort_by"`, … — looked up in the
    /// translator's library. Never an integer.
    pub op: String,
    pub out_type: Type,
    /// The nodes whose results this one consumes. Explicit, so the graph is a
    /// DAG the validator can walk without guessing at dependencies.
    pub inputs: Vec<u16>,
    /// Op-specific small integers: a field index for `load_field`, an 8.8
    /// fixed-point factor for `parallax_offset`.
    pub args: Vec<u16>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Stage {
    pub id: u16,
    pub name: String,
    pub canvas: (u16, u16),
    /// Index into [`Graph::records`].
    pub record_ref: u16,
    pub nodes: Vec<Node>,
    /// The nodes that terminate the stage. Every stage must name at least one,
    /// and it must be an `emit_*` node.
    pub emits: Vec<u16>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Uniform {
    pub name: String,
    /// 0 = vec2, 1 = vec4.
    pub ty: u8,
    pub slot: u16,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Binding {
    pub stage_ref: u16,
    pub resource_ref: u16,
    pub slot: u16,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Graph {
    pub records: Vec<RecordDef>,
    pub stages: Vec<Stage>,
    pub uniforms: Vec<Uniform>,
    pub bindings: Vec<Binding>,
}

impl Graph {
    /// FNV-1a over the blob bytes.
    ///
    /// The cache key is the *bytes*, not the parsed structure: two encodings of
    /// the same graph should compile separately and be told apart, because a
    /// difference in bytes is a difference someone made deliberately.
    pub fn hash(blob: &[u8]) -> u64 {
        let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
        for byte in blob {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
        hash
    }

    pub fn stage(&self, id: u16) -> Option<&Stage> {
        self.stages.iter().find(|stage| stage.id == id)
    }
}

/// Why compilation could not proceed. Maps onto the adapter's refusals: a
/// malformed blob is `-EINVAL`, an op this build cannot lower is `-ENOSYS`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GraphError {
    /// The blob is not a graph, or is not this version of one.
    Malformed(String),
    /// Structurally valid but semantically wrong: a dangling input, a field
    /// index out of range, a cycle.
    Invalid(String),
    /// Valid, but this build has no lowering for it.
    Unsupported(String),
}

impl GraphError {
    pub fn errno(&self) -> i32 {
        match self {
            GraphError::Malformed(_) => -22,    // -EINVAL
            GraphError::Invalid(_) => -22,      // -EINVAL
            GraphError::Unsupported(_) => -38,  // -ENOSYS
        }
    }
}

impl std::fmt::Display for GraphError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            GraphError::Malformed(m) => write!(f, "malformed graph: {m}"),
            GraphError::Invalid(m) => write!(f, "invalid graph: {m}"),
            GraphError::Unsupported(m) => write!(f, "unsupported graph: {m}"),
        }
    }
}

pub type Result<T> = std::result::Result<T, GraphError>;
