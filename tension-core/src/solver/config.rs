//! The configuration struct: the guest wire (DESIGN.md §12) and the C-layout
//! struct the shim takes.
//!
//! Two halves, one contract. [`decode_wire`] is the host as **strict reader**:
//! it validates the guest's bytes against §12 and refuses — never guessing,
//! never half-reading — anything that does not match. [`DecodedConfig`] owns
//! the strings it copies out of the wire, and [`DecodedConfig::to_c_config`]
//! fills the `#[repr(C)]` mirror of `tension_solver_config`
//! (tension-solver/include/tension_solver.h) with pointers into those owned
//! strings: the shim reads a struct, never the wire.
//!
//! The layering rule (§12): the framework is the writer and owns the format
//! on the guest side; the host refuses what does not match; if the two ever
//! disagree, the framework changes. The world-source semantics (`dim` is
//! derived, never stated) are enforced here because the shim has no `world`
//! field at all — the YAML never crosses into the C level.
//!
//! Allocation: the decoder allocates for the strings it copies out and for
//! nothing else — no buffer is sized from an unvalidated length before the
//! bounds are checked.

use std::ffi::c_char;
use std::fmt;

/// §12's magic: ASCII `TNSCONF1` = `54 4E 53 43 4F 4E 46 31`.
pub const MAGIC: [u8; 8] = *b"TNSCONF1";

/// The header's size in bytes (§12: 64, `reserved` pads it).
const HEADER_LEN: usize = 64;
/// The only `format_version` this build reads.
const FORMAT_VERSION: u16 = 1;
/// The only `schema_version` this build reads (schema.yaml's `schema_version`).
const SCHEMA_VERSION: u16 = 1;
/// The nine named parameter bits; 9-31 are reserved and must be zero.
const PARAMETER_BITS: u32 = 0x1FF;

/// The header's `tension_solver_config`, field for field. `#[repr(C)]` with
/// the same field order reproduces the C layout exactly (pointers 8-aligned,
/// `u32`s packed after them, the `f64`s 8-aligned at the tail).
///
/// Every pointer borrows: the struct is valid only while the [`DecodedConfig`]
/// it came from is alive, and the shim only needs it for the duration of one
/// `tension_solver_create` call.
#[repr(C)]
pub struct TensionSolverConfig {
    pub method: *const c_char,
    pub method_len: u32,
    pub source: *const c_char,
    pub source_len: u32,
    pub description: *const c_char,
    pub description_len: u32,
    pub dim: u32,
    pub parameters_bitmap: u32,
    pub rel_tol: f64,
    pub abs_tol: f64,
    pub min_step: f64,
    pub max_step: f64,
    pub fixed_step: f64,
    pub iterations: u32,
    pub convergence_tol: f64,
    pub compliance: f64,
    pub relaxation: f64,
}

/// Why a wire blob was refused. One variant per refusal in §12's reader
/// contract (plus [`ConfigError::TooShort`], the degenerate form of "an
/// offset falls outside the blob": a blob that cannot even hold the header
/// has no header to read).
#[derive(Debug, PartialEq, Eq)]
pub enum ConfigError {
    /// Fewer bytes than the 64-byte header.
    TooShort { len: usize },
    /// The first eight bytes are not `TNSCONF1`.
    BadMagic,
    /// A `format_version` this build does not read.
    UnknownFormatVersion(u16),
    /// A `schema_version` this build does not read.
    UnknownSchemaVersion(u16),
    /// The `reserved` bytes were not zero.
    ReservedNotZero,
    /// `parameters_bitmap` had a bit set outside the nine named ones.
    ReservedParameterBits(u32),
    /// `method_len == 0`.
    EmptyMethod,
    /// `source_len == 0`.
    EmptySource,
    /// An offset/length pair reaching outside the blob.
    OutOfBounds { field: &'static str },
    /// `parameters_off` that is neither 0 nor 64, or that disagrees with the
    /// bitmap (0 with a nonzero bitmap, 64 with a zero one).
    BadParametersOffset(u32),
    /// The `iterations` slot's upper four bytes were not zero.
    IterationsUpperBits { slot: u64 },
    /// A string pointer that is not at an entry's length prefix, or an entry
    /// whose bytes run past the blob (or whose prefix disagrees with the
    /// header's length).
    BadStringEntry { field: &'static str },
    /// The walk did not land exactly on the end of the blob: a gap, or
    /// trailing bytes.
    TrailingBytes { walked: usize, len: usize },
    /// `source: "world"` with a nonzero `dim` (the host derives it).
    WorldStatesDim(u32),
    /// `source: "world"` with no `world` text.
    WorldTextMissing,
    /// World text on a config whose source is not `world`.
    WorldOnNonWorldSource,
}

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TooShort { len } => {
                write!(f, "blob is {len} bytes; the header alone is {HEADER_LEN}")
            }
            Self::BadMagic => write!(f, "bad magic (expected TNSCONF1)"),
            Self::UnknownFormatVersion(v) => write!(f, "format_version {v} is not read by this build"),
            Self::UnknownSchemaVersion(v) => write!(f, "schema_version {v} is not read by this build"),
            Self::ReservedNotZero => write!(f, "the reserved header bytes are not zero"),
            Self::ReservedParameterBits(b) => {
                write!(f, "parameters_bitmap {b:#010x} sets a reserved bit (9-31)")
            }
            Self::EmptyMethod => write!(f, "method_len is 0"),
            Self::EmptySource => write!(f, "source_len is 0"),
            Self::OutOfBounds { field } => write!(f, "{field} reaches outside the blob"),
            Self::BadParametersOffset(off) => {
                write!(f, "parameters_off {off} disagrees with the parameters bitmap")
            }
            Self::IterationsUpperBits { slot } => {
                write!(f, "the iterations slot ({slot:#018x}) has nonzero upper four bytes")
            }
            Self::BadStringEntry { field } => {
                write!(f, "{field} does not point at a string-table entry inside the blob")
            }
            Self::TrailingBytes { walked, len } => {
                write!(f, "the string table walks {walked} of {len} bytes")
            }
            Self::WorldStatesDim(dim) => {
                write!(f, "source \"world\" states dim {dim}; the host derives it")
            }
            Self::WorldTextMissing => write!(f, "source \"world\" carries no world text"),
            Self::WorldOnNonWorldSource => {
                write!(f, "world text on a config whose source is not \"world\"")
            }
        }
    }
}

/// A validated wire blob, as owned Rust values.
///
/// `None` on a parameter means the bit was clear: the schema's declared
/// default applies and the shim must not read a value for it. The bitmap the
/// shim receives is recomputed from these fields by [`Self::to_c_config`], so
/// there is exactly one place that decides what "present" means.
#[derive(Debug, Default, PartialEq)]
pub struct DecodedConfig {
    pub method: String,
    pub source: String,
    pub description: Option<String>,
    pub dim: u32,
    /// The YAML text; the shim never sees it (its struct has no field for it).
    pub world: Option<String>,
    pub rel_tol: Option<f64>,
    pub abs_tol: Option<f64>,
    pub min_step: Option<f64>,
    pub max_step: Option<f64>,
    pub fixed_step: Option<f64>,
    pub iterations: Option<u32>,
    pub convergence_tol: Option<f64>,
    pub compliance: Option<f64>,
    pub relaxation: Option<f64>,
}

impl DecodedConfig {
    /// Fill the C-layout struct with pointers into this value's strings.
    /// The result borrows: it is valid only while `self` is alive.
    pub fn to_c_config(&self) -> TensionSolverConfig {
        let mut bitmap = 0u32;
        for (bit, present) in [
            self.rel_tol.is_some(),
            self.abs_tol.is_some(),
            self.min_step.is_some(),
            self.max_step.is_some(),
            self.fixed_step.is_some(),
            self.iterations.is_some(),
            self.convergence_tol.is_some(),
            self.compliance.is_some(),
            self.relaxation.is_some(),
        ]
        .into_iter()
        .enumerate()
        {
            if present {
                bitmap |= 1 << bit;
            }
        }
        let (description, description_len) = match &self.description {
            Some(text) => (text.as_ptr().cast::<c_char>(), text.len() as u32),
            None => (std::ptr::null(), 0),
        };
        TensionSolverConfig {
            method: self.method.as_ptr().cast(),
            method_len: self.method.len() as u32,
            source: self.source.as_ptr().cast(),
            source_len: self.source.len() as u32,
            description,
            description_len,
            dim: self.dim,
            parameters_bitmap: bitmap,
            rel_tol: self.rel_tol.unwrap_or(0.0),
            abs_tol: self.abs_tol.unwrap_or(0.0),
            min_step: self.min_step.unwrap_or(0.0),
            max_step: self.max_step.unwrap_or(0.0),
            fixed_step: self.fixed_step.unwrap_or(0.0),
            iterations: self.iterations.unwrap_or(0),
            convergence_tol: self.convergence_tol.unwrap_or(0.0),
            compliance: self.compliance.unwrap_or(0.0),
            relaxation: self.relaxation.unwrap_or(0.0),
        }
    }
}

fn u16_at(bytes: &[u8], off: usize) -> u16 {
    let mut v = 0u16;
    for i in 0..2 {
        v |= (bytes[off + i] as u16) << (8 * i);
    }
    v
}

fn u32_at(bytes: &[u8], off: usize) -> u32 {
    let mut v = 0u32;
    for i in 0..4 {
        v |= (bytes[off + i] as u32) << (8 * i);
    }
    v
}

fn u64_at(bytes: &[u8], off: usize) -> u64 {
    let mut v = 0u64;
    for i in 0..8 {
        v |= (bytes[off + i] as u64) << (8 * i);
    }
    v
}

/// One string-table entry as the header declares it: where it must sit, and
/// how long it must be.
struct Entry {
    field: &'static str,
    ptr: u32,
    len: u32,
}

/// Decode the §12 wire layout. Strict: every refusal in §12's reader contract
/// is a distinct [`ConfigError`], and nothing is read past a check.
pub fn decode_wire(bytes: &[u8]) -> Result<DecodedConfig, ConfigError> {
    if bytes.len() < HEADER_LEN {
        return Err(ConfigError::TooShort { len: bytes.len() });
    }
    if bytes[0..8] != MAGIC {
        return Err(ConfigError::BadMagic);
    }
    let format_version = u16_at(bytes, 8);
    if format_version != FORMAT_VERSION {
        return Err(ConfigError::UnknownFormatVersion(format_version));
    }
    let schema_version = u16_at(bytes, 10);
    if schema_version != SCHEMA_VERSION {
        return Err(ConfigError::UnknownSchemaVersion(schema_version));
    }
    if bytes[56..64].iter().any(|&b| b != 0) {
        return Err(ConfigError::ReservedNotZero);
    }

    let method_ptr = u32_at(bytes, 12);
    let method_len = u32_at(bytes, 16);
    let source_ptr = u32_at(bytes, 20);
    let source_len = u32_at(bytes, 24);
    let description_ptr = u32_at(bytes, 28);
    let description_len = u32_at(bytes, 32);
    let dim = u32_at(bytes, 36);
    let parameters_off = u32_at(bytes, 40);
    let parameters_bitmap = u32_at(bytes, 44);
    let world_ptr = u32_at(bytes, 48);
    let world_len = u32_at(bytes, 52);

    if method_len == 0 {
        return Err(ConfigError::EmptyMethod);
    }
    if source_len == 0 {
        return Err(ConfigError::EmptySource);
    }
    if parameters_bitmap & !PARAMETER_BITS != 0 {
        return Err(ConfigError::ReservedParameterBits(parameters_bitmap));
    }

    // The parameters block: present exactly when the bitmap is nonzero, and
    // its offset is then fixed at 64 (§12: derived positions are not optional).
    let popcount = parameters_bitmap.count_ones() as usize;
    let table_start = if parameters_bitmap == 0 {
        if parameters_off != 0 {
            return Err(ConfigError::BadParametersOffset(parameters_off));
        }
        HEADER_LEN
    } else {
        if parameters_off != HEADER_LEN as u32 {
            return Err(ConfigError::BadParametersOffset(parameters_off));
        }
        HEADER_LEN + 8 * popcount
    };
    if table_start > bytes.len() {
        return Err(ConfigError::OutOfBounds { field: "parameters block" });
    }

    // Collect the stated parameters: slot k of the block belongs to the k-th
    // set bit, in bit order.
    let mut decoded = DecodedConfig::default();
    let mut slot = HEADER_LEN;
    for bit in 0..9u32 {
        if parameters_bitmap & (1 << bit) == 0 {
            continue;
        }
        let raw = u64_at(bytes, slot);
        match bit {
            0 => decoded.rel_tol = Some(f64::from_bits(raw)),
            1 => decoded.abs_tol = Some(f64::from_bits(raw)),
            2 => decoded.min_step = Some(f64::from_bits(raw)),
            3 => decoded.max_step = Some(f64::from_bits(raw)),
            4 => decoded.fixed_step = Some(f64::from_bits(raw)),
            5 => {
                // schema type u32: the low four bytes; the upper four are zero
                if raw >> 32 != 0 {
                    return Err(ConfigError::IterationsUpperBits { slot: raw });
                }
                decoded.iterations = Some(raw as u32);
            }
            6 => decoded.convergence_tol = Some(f64::from_bits(raw)),
            7 => decoded.compliance = Some(f64::from_bits(raw)),
            8 => decoded.relaxation = Some(f64::from_bits(raw)),
            _ => unreachable!("the loop is bounded by the nine named bits"),
        }
        slot += 8;
    }

    // The string table: a walk from `table_start` to the last byte. The entry
    // order is the header's field order — method, source, description, world —
    // and an entry with length 0 is absent, not empty (the framework writes
    // 0,0 for an absent one).
    let entries = [
        Entry { field: "method", ptr: method_ptr, len: method_len },
        Entry { field: "source", ptr: source_ptr, len: source_len },
        Entry { field: "description", ptr: description_ptr, len: description_len },
        Entry { field: "world", ptr: world_ptr, len: world_len },
    ];
    let mut cursor = table_start;
    let mut texts: [Option<String>; 4] = [None, None, None, None];
    for (i, entry) in entries.iter().enumerate() {
        if entry.len == 0 {
            continue; // absent: method/source would have been refused above
        }
        let start = entry.ptr as usize;
        if start != cursor || start.checked_add(4).is_none_or(|e| e > bytes.len()) {
            return Err(ConfigError::BadStringEntry { field: entry.field });
        }
        if u32_at(bytes, start) != entry.len {
            return Err(ConfigError::BadStringEntry { field: entry.field });
        }
        let body = start + 4;
        let Some(end) = body.checked_add(entry.len as usize) else {
            return Err(ConfigError::BadStringEntry { field: entry.field });
        };
        if end > bytes.len() {
            return Err(ConfigError::BadStringEntry { field: entry.field });
        }
        // The ABI's strings are UTF-8 by construction; a blob whose bytes are
        // not is refused here rather than handed to the shim as a name that
        // can never match.
        let Ok(text) = std::str::from_utf8(&bytes[body..end]) else {
            return Err(ConfigError::BadStringEntry { field: entry.field });
        };
        texts[i] = Some(text.to_owned());
        cursor = end;
    }
    if cursor != bytes.len() {
        return Err(ConfigError::TrailingBytes { walked: cursor, len: bytes.len() });
    }

    decoded.method = texts[0].take().expect("method_len is never 0");
    decoded.source = texts[1].take().expect("source_len is never 0");
    decoded.description = texts[2].take();
    decoded.world = texts[3].take();
    decoded.dim = dim;

    // The world-source rules of §12: dim is the host's to derive, and a world
    // source without world text has no f. Both are host-side because the shim
    // has no world field; the shim refuses a synthesized dim of 0 in return.
    if decoded.source == "world" {
        if dim != 0 {
            return Err(ConfigError::WorldStatesDim(dim));
        }
        if decoded.world.is_none() {
            return Err(ConfigError::WorldTextMissing);
        }
    } else if decoded.world.is_some() {
        return Err(ConfigError::WorldOnNonWorldSource);
    }

    Ok(decoded)
}
