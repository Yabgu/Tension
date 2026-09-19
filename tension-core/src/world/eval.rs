//! The world evaluator (P8d): reads a compiled world and computes f(t, y),
//! the right-hand side `source: "world"` will hand the solver.
//!
//! The split of responsibilities is the same one the resource subsystem
//! keeps: [`World::load`] enforces every structural refusal
//! `tension-world/DESIGN.md` §4 declares — magic, versions, reserved
//! fields, dimensions, offsets, counts, and the bounds-checked table
//! walks — and one class more: a connection whose endpoints do not name
//! component-table entries is refused rather than half-read, because a
//! dangling reference would otherwise evaluate as if the connection were
//! absent. Whether a spring's stiffness is positive, or a mass nonzero,
//! is the compiler's contract (`schema.yaml`, P8c); the loader does not
//! re-litigate semantics, and evaluation assumes them — a hand-built
//! binary that breaks a semantic rule gets IEEE arithmetic, not an error
//! (a zero mass divides to infinity).
//!
//! [`World::eval`] is the hot path. It is pure in `(t, y)`: same inputs,
//! bit-identical out, every time — no globals, no interior mutability,
//! nothing that a second call could observe from the first. That is what
//! lets the solver's determinism contract (tension-solver/DESIGN.md §5)
//! compose with the world's. And it allocates nothing: the per-component
//! force accumulator is a `[f64; 3]` on the stack, and the component
//! gather loops over the connection table instead of building any index.
//!
//! The numeric vocabulary (DESIGN.md §2, §4–§6) is transcribed here
//! independently of `compiler.rs`: the reader is not the writer's mirror,
//! and neither refers to the other's constants.

use std::fmt;
use std::str;

/// DESIGN.md §2: the first eight bytes of every world file.
const MAGIC: &[u8; 8] = b"TNSWORLD";
/// DESIGN.md §4: the only format version this reader knows.
const FORMAT_VERSION: u16 = 1;
/// DESIGN.md §4: the header's size, and the component table's fixed start.
const HEADER_LEN: u32 = 40;
/// DESIGN.md §6: the sentinel `from`/`to` gravity carries.
const NO_ENDPOINT: u32 = 0xFFFF_FFFF;
/// DESIGN.md §5: component type tags.
const TAG_POINT_MASS: u16 = 1;
const TAG_KINEMATIC: u16 = 2;
const TAG_ANCHOR: u16 = 3;
/// DESIGN.md §6: connection type tags.
const TAG_SPRING: u16 = 1;
const TAG_PIN: u16 = 2;
const TAG_GRAVITY: u16 = 3;

/// Why a world could not be loaded or evaluated.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorldError<'a> {
    /// The first eight bytes are not `TNSWORLD` (DESIGN.md §2).
    BadMagic,
    /// `format_version` is not the one version this reader knows (§4, §9).
    BadVersion { found: u16 },
    /// `flags`, `reserved`, or `reserved2` is nonzero (§4).
    BadFlags,
    /// `dimensions` is not 2 or 3 (§4).
    BadDimensions { found: u8 },
    /// A table offset is misaligned, out of range, or disagrees with the
    /// tables' actual extents; or a name entry is malformed (§4, §7).
    BadOffset,
    /// The file ends before its tables do, or a count does not fit inside
    /// its table (§4).
    Truncated,
    /// A connection's `from`/`to` does not name a component-table entry,
    /// gravity's endpoints are not the `0xFFFF_FFFF` sentinel, or a binary
    /// connection's `from` equals its `to` (§6).
    BadReference { connection: u32 },
    /// `y` or `out` is not `dim` slots long.
    DimMismatch { expected: u32, got: usize },
    /// A component type tag this reader cannot size; load refuses the file
    /// (§5). `name` is filled when the refusal happens after the name
    /// table was reached, which for components never is.
    UnsupportedComponent { index: u32, tag: u16, name: Option<&'a str> },
    /// A connection the binary declares that v1 cannot evaluate: `pin`'s
    /// rigid constraint has no force form (`f(t, y)` receives no `dt`), so
    /// evaluation refuses a world that carries one (§12).
    UnsupportedConnection { index: u32, tag: u16, name: Option<&'a str> },
}

impl fmt::Display for WorldError<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match *self {
            WorldError::BadMagic => f.write_str("not a world file: bad magic"),
            WorldError::BadVersion { found } => write!(
                f,
                "unsupported format_version {found}: this reader implements {FORMAT_VERSION}"
            ),
            WorldError::BadFlags => {
                f.write_str("reserved header fields (flags, reserved, reserved2) must be zero")
            }
            WorldError::BadDimensions { found } => {
                write!(f, "dimensions must be 2 or 3, found {found}")
            }
            WorldError::BadOffset => f.write_str(
                "a table offset is misaligned, out of range, or disagrees with the tables' extents",
            ),
            WorldError::Truncated => f.write_str("the file ends before its tables do"),
            WorldError::BadReference { connection } => write!(
                f,
                "connection at index {connection} references a component that does not exist (or misuses the endpoint sentinels)"
            ),
            WorldError::DimMismatch { expected, got } => {
                write!(f, "expected {expected} state slots, got {got}")
            }
            WorldError::UnsupportedComponent { index, tag, name } => match name {
                Some(name) => write!(
                    f,
                    "component `{name}` (index {index}): component type tag {tag} is not implemented in v1"
                ),
                None => write!(
                    f,
                    "component at index {index}: component type tag {tag} is not implemented in v1"
                ),
            },
            WorldError::UnsupportedConnection { index, tag, name } => {
                match (name, tag == TAG_PIN) {
                    (Some(name), true) => write!(
                        f,
                        "connection `{name}` (index {index}): rigid constraints (`pin`) are not implemented in v1"
                    ),
                    (None, true) => write!(
                        f,
                        "connection at index {index}: rigid constraints (`pin`) are not implemented in v1"
                    ),
                    (Some(name), false) => write!(
                        f,
                        "connection `{name}` (index {index}): connection type tag {tag} is not implemented in v1"
                    ),
                    (None, false) => write!(
                        f,
                        "connection at index {index}: connection type tag {tag} is not implemented in v1"
                    ),
                }
            }
        }
    }
}

impl std::error::Error for WorldError<'_> {}

/// A validated, borrowed view of one compiled world.
///
/// `load` allocates nothing and takes ownership of nothing: the compiled
/// bytes stay the caller's, and every later read is an offset into them.
#[derive(Debug)]
pub struct World<'a> {
    bytes: &'a [u8],
    dimensions: u8,
    dim: u32,
    component_count: u32,
    connection_count: u32,
    component_table: usize,
    connection_table: usize,
}

impl<'a> World<'a> {
    /// Read and validate the compiled bytes (DESIGN.md §4–§7).
    ///
    /// # Errors
    ///
    /// Every structural refusal the format declares, with one addition
    /// named in the module docs: a connection whose endpoints do not name
    /// component-table entries is refused here, not half-read.
    pub fn load(bytes: &'a [u8]) -> Result<Self, WorldError<'a>> {
        if bytes.len() < HEADER_LEN as usize {
            return Err(WorldError::Truncated);
        }
        if &bytes[0..8] != MAGIC {
            return Err(WorldError::BadMagic);
        }
        let format_version = u16_at(bytes, 8);
        if format_version != FORMAT_VERSION {
            return Err(WorldError::BadVersion { found: format_version });
        }
        if bytes[13] != 0 || u16_at(bytes, 14) != 0 || u32_at(bytes, 36) != 0 {
            return Err(WorldError::BadFlags);
        }
        let dimensions = bytes[12];
        if dimensions != 2 && dimensions != 3 {
            return Err(WorldError::BadDimensions { found: dimensions });
        }
        let d = dimensions as usize;

        let component_count = u32_at(bytes, 16);
        let connection_count = u32_at(bytes, 20);
        let component_table = u32_at(bytes, 24) as usize;
        let connection_table = u32_at(bytes, 28) as usize;
        let name_table = u32_at(bytes, 32) as usize;

        // The layout is fixed: the component table starts at 40, the
        // connection table follows it, the name table follows that (or is
        // absent). A field that disagrees with where a table must be is
        // refused, not followed.
        if component_table != HEADER_LEN as usize
            || connection_table < component_table
            || connection_table > bytes.len()
            || (name_table != 0 && (name_table < connection_table || name_table > bytes.len()))
        {
            return Err(WorldError::BadOffset);
        }

        // Component table: walk by tag, accumulate dim. An unknown tag
        // stops the walk — its entry size is unknowable (§5).
        let mut off = component_table;
        let mut dim = 0u32;
        for index in 0..component_count {
            if off + 8 > connection_table {
                return Err(WorldError::Truncated);
            }
            let tag = u16_at(bytes, off);
            let name_offset = u32_at(bytes, off + 4);
            let Some(size) = component_size(tag, d) else {
                return Err(WorldError::UnsupportedComponent { index, tag, name: None });
            };
            // Components are never unnamed (§5, §7).
            if name_offset == 0 {
                return Err(WorldError::BadOffset);
            }
            if off + size > connection_table {
                return Err(WorldError::Truncated);
            }
            if tag != TAG_ANCHOR {
                dim += 2 * d as u32;
            }
            off += size;
        }
        if off != connection_table {
            return Err(WorldError::BadOffset);
        }

        // Connection table: endpoints must name real components; gravity
        // carries the sentinel; a binary connection's ends must differ (§6).
        let conn_section_end = if name_table == 0 { bytes.len() } else { name_table };
        let mut off = connection_table;
        for index in 0..connection_count {
            if off + 16 > conn_section_end {
                return Err(WorldError::Truncated);
            }
            let tag = u16_at(bytes, off);
            let from = u32_at(bytes, off + 8);
            let to = u32_at(bytes, off + 12);
            let Some(size) = connection_size(tag, d) else {
                return Err(WorldError::UnsupportedConnection { index, tag, name: None });
            };
            if off + size > conn_section_end {
                return Err(WorldError::Truncated);
            }
            match tag {
                TAG_GRAVITY => {
                    if from != NO_ENDPOINT || to != NO_ENDPOINT {
                        return Err(WorldError::BadReference { connection: index });
                    }
                }
                _ => {
                    if from >= component_count || to >= component_count || from == to {
                        return Err(WorldError::BadReference { connection: index });
                    }
                }
            }
            off += size;
        }
        if off != conn_section_end {
            return Err(WorldError::BadOffset);
        }

        // Name table: length-prefixed UTF-8, no padding, to the end of the
        // file (§7).
        if name_table == 0 {
            if off != bytes.len() {
                return Err(WorldError::BadOffset);
            }
        } else {
            let mut off = name_table;
            while off < bytes.len() {
                if off + 4 > bytes.len() {
                    return Err(WorldError::Truncated);
                }
                let len = u32_at(bytes, off) as usize;
                let Some(end) = off.checked_add(4).and_then(|start| start.checked_add(len)) else {
                    return Err(WorldError::Truncated);
                };
                if end > bytes.len() {
                    return Err(WorldError::Truncated);
                }
                if str::from_utf8(&bytes[off + 4..end]).is_err() {
                    return Err(WorldError::BadOffset);
                }
                off = end;
            }
        }

        // Every name_offset points into the name table, at a well-formed
        // entry (§5, §7) — the error paths above this line read names
        // through these offsets, so their bounds are checked once, here.
        let check_name = |name_offset: u32| -> Result<(), WorldError<'a>> {
            if name_offset == 0 {
                return Ok(()); // unnamed; only legal for connections, checked below
            }
            let off = name_offset as usize;
            if name_table == 0 || off < name_table || off + 4 > bytes.len() {
                return Err(WorldError::BadOffset);
            }
            let len = u32_at(bytes, off) as usize;
            let Some(end) = off.checked_add(4).and_then(|start| start.checked_add(len)) else {
                return Err(WorldError::BadOffset);
            };
            if end > bytes.len() || str::from_utf8(&bytes[off + 4..end]).is_err() {
                return Err(WorldError::BadOffset);
            }
            Ok(())
        };
        let mut off = component_table;
        for _ in 0..component_count {
            check_name(u32_at(bytes, off + 4))?;
            off += component_size(u16_at(bytes, off), d).unwrap_or_else(|| unreachable!());
        }
        let mut off = connection_table;
        for _ in 0..connection_count {
            check_name(u32_at(bytes, off + 4))?;
            off += connection_size(u16_at(bytes, off), d).unwrap_or_else(|| unreachable!());
        }

        Ok(World {
            bytes,
            dimensions,
            dim,
            component_count,
            connection_count,
            component_table,
            connection_table,
        })
    }

    /// The state vector's length: Σ each component's slot count (§5,
    /// schema §dimensions). 0 is legal data.
    #[must_use]
    pub fn dim(&self) -> u32 {
        self.dim
    }

    /// The world's spatial dimensionality: 2 or 3.
    #[must_use]
    pub fn dimensions(&self) -> u8 {
        self.dimensions
    }

    /// Compute f(t, y) into `out` (both `dim` slots long).
    ///
    /// Pure: same `(t, y)`, bit-identical `out`, every time. Allocation-free.
    /// `t` is accepted as the solver's calling convention and is currently
    /// unread — no v1 connection makes f depend on time. On error, `out`
    /// may hold a partial derivative.
    ///
    /// # Errors
    ///
    /// [`WorldError::DimMismatch`] when `y` or `out` is not `dim` slots;
    /// [`WorldError::UnsupportedConnection`] when the world carries a
    /// rigid pin, which has no force form (§12).
    pub fn eval(&self, t: f64, y: &[f64], out: &mut [f64]) -> Result<(), WorldError<'a>> {
        let _ = t;
        let dim = self.dim as usize;
        if y.len() != dim {
            return Err(WorldError::DimMismatch { expected: self.dim, got: y.len() });
        }
        if out.len() != dim {
            return Err(WorldError::DimMismatch { expected: self.dim, got: out.len() });
        }

        // A pin cannot be evaluated, and dim can be 0 (anchors only) while a
        // pin is still present, so this cannot ride inside the component
        // walk below. Refuse before writing anything.
        let mut off = self.connection_table;
        for index in 0..self.connection_count {
            let tag = u16_at(self.bytes, off);
            if tag == TAG_PIN {
                return Err(WorldError::UnsupportedConnection {
                    index,
                    tag,
                    name: self.name_at(u32_at(self.bytes, off + 4)),
                });
            }
            off += self.connection_entry_size(tag);
        }

        let d = self.dimensions as usize;
        let mut off = self.component_table;
        let mut slot = 0usize;
        for index in 0..self.component_count {
            let tag = u16_at(self.bytes, off);
            match tag {
                TAG_POINT_MASS => {
                    let mass = f64_at(self.bytes, off + 8);
                    for k in 0..d {
                        out[slot + k] = y[slot + d + k]; // position' = velocity
                    }
                    let force = self.force_on(index, mass, y);
                    for k in 0..d {
                        out[slot + d + k] = force[k] / mass; // velocity' = force / mass
                    }
                    slot += 2 * d;
                }
                TAG_KINEMATIC => {
                    for k in 0..d {
                        out[slot + k] = y[slot + d + k]; // position' = velocity
                        out[slot + d + k] = 0.0; // nothing drives a kinematic body
                    }
                    slot += 2 * d;
                }
                TAG_ANCHOR => {} // no slots, no contribution
                other => unreachable!("component tag {other} survived load"),
            }
            off += self.component_entry_size(tag);
        }

        Ok(())
    }

    // ── internals ───────────────────────────────────────────────────────

    /// The total force on component `index` at state `y`: every spring the
    /// component participates in, plus gravity (as `mass · a`) when it is a
    /// point_mass — which is the only caller.
    fn force_on(&self, index: u32, mass: f64, y: &[f64]) -> [f64; 3] {
        let d = self.dimensions as usize;
        let mut force = [0.0f64; 3];
        let mut pos_i = [0.0f64; 3];
        let mut vel_i = [0.0f64; 3];
        if self.component_state(index, y, &mut pos_i, &mut vel_i).is_none() {
            return force; // unreachable after load; not a panic
        }

        let mut off = self.connection_table;
        for _ in 0..self.connection_count {
            let tag = u16_at(self.bytes, off);
            match tag {
                TAG_SPRING => {
                    let from = u32_at(self.bytes, off + 8);
                    let to = u32_at(self.bytes, off + 12);
                    if from == index || to == index {
                        let other = if from == index { to } else { from };
                        let mut pos_j = [0.0f64; 3];
                        let mut vel_j = [0.0f64; 3];
                        if self
                            .component_state(other, y, &mut pos_j, &mut vel_j)
                            .is_some()
                        {
                            // The spring has an orientation: `dir` runs from
                            // `from` to `to`, and the force flips sign with
                            // the end we are on (§12).
                            let (pos_from, vel_from, pos_to, vel_to) = if from == index {
                                (pos_i, vel_i, pos_j, vel_j)
                            } else {
                                (pos_j, vel_j, pos_i, vel_i)
                            };
                            let mut delta = [0.0f64; 3];
                            let mut v_rel = [0.0f64; 3];
                            let mut dist2 = 0.0f64;
                            for k in 0..d {
                                delta[k] = pos_to[k] - pos_from[k];
                                v_rel[k] = vel_to[k] - vel_from[k];
                                dist2 += delta[k] * delta[k];
                            }
                            let dist = dist2.sqrt();
                            // Coincident endpoints have no axis to pull
                            // along; v1 contributes no force rather than a
                            // NaN direction (recorded in §12).
                            if dist > 0.0 {
                                let inv = 1.0 / dist;
                                let stiffness = f64_at(self.bytes, off + 16);
                                let rest_length = f64_at(self.bytes, off + 24);
                                let damping = f64_at(self.bytes, off + 32);
                                let mut radial = 0.0f64;
                                for k in 0..d {
                                    radial += v_rel[k] * delta[k] * inv;
                                }
                                let magnitude =
                                    -stiffness * (dist - rest_length) - damping * radial;
                                let sign = if from == index { -1.0 } else { 1.0 };
                                for k in 0..d {
                                    force[k] += sign * magnitude * delta[k] * inv;
                                }
                            }
                        }
                    }
                }
                TAG_GRAVITY => {
                    for k in 0..d {
                        force[k] += mass * f64_at(self.bytes, off + 16 + 8 * k);
                    }
                }
                _ => {} // pins were refused above; load refused anything else
            }
            off += self.connection_entry_size(tag);
        }
        force
    }

    /// Component `index`'s current position and velocity: its state slots
    /// read from `y`, or — for an anchor, which has no slots — its stored
    /// position and a zero velocity (§5). `None` for an index outside the
    /// table, which load refuses.
    fn component_state(
        &self,
        index: u32,
        y: &[f64],
        pos: &mut [f64; 3],
        vel: &mut [f64; 3],
    ) -> Option<u16> {
        let d = self.dimensions as usize;
        let mut off = self.component_table;
        let mut slot = 0usize;
        for i in 0..self.component_count {
            let tag = u16_at(self.bytes, off);
            if i == index {
                if tag == TAG_ANCHOR {
                    for k in 0..d {
                        pos[k] = f64_at(self.bytes, off + 8 + 8 * k);
                        vel[k] = 0.0;
                    }
                } else {
                    for k in 0..d {
                        pos[k] = y[slot + k];
                        vel[k] = y[slot + d + k];
                    }
                }
                return Some(tag);
            }
            if tag != TAG_ANCHOR {
                slot += 2 * d;
            }
            off += self.component_entry_size(tag);
        }
        None
    }

    fn component_entry_size(&self, tag: u16) -> usize {
        component_size(tag, self.dimensions as usize)
            .unwrap_or_else(|| unreachable!("component tag {tag} survived load"))
    }

    fn connection_entry_size(&self, tag: u16) -> usize {
        connection_size(tag, self.dimensions as usize)
            .unwrap_or_else(|| unreachable!("connection tag {tag} survived load"))
    }

    /// The name at a `name_offset`, when there is one (§7). Load validated
    /// every offset and every entry, so this reads allocated-nothing and
    /// cannot leave the file.
    fn name_at(&self, name_offset: u32) -> Option<&'a str> {
        if name_offset == 0 {
            return None;
        }
        let off = name_offset as usize;
        let len = u32_at(self.bytes, off) as usize;
        str::from_utf8(&self.bytes[off + 4..off + 4 + len]).ok()
    }
}

/// Entry size by component tag (§5), `None` for a tag this reader does not
/// know.
fn component_size(tag: u16, dimensions: usize) -> Option<usize> {
    match tag {
        TAG_POINT_MASS => Some(16 + 16 * dimensions),
        TAG_KINEMATIC => Some(8 + 16 * dimensions),
        TAG_ANCHOR => Some(8 + 8 * dimensions),
        _ => None,
    }
}

/// Entry size by connection tag (§6), `None` for a tag this reader does
/// not know.
fn connection_size(tag: u16, dimensions: usize) -> Option<usize> {
    match tag {
        TAG_SPRING => Some(40),
        TAG_PIN | TAG_GRAVITY => Some(16 + 8 * dimensions),
        _ => None,
    }
}

fn u16_at(bytes: &[u8], off: usize) -> u16 {
    u16::from_le_bytes(bytes[off..off + 2].try_into().unwrap())
}

fn u32_at(bytes: &[u8], off: usize) -> u32 {
    u32::from_le_bytes(bytes[off..off + 4].try_into().unwrap())
}

fn f64_at(bytes: &[u8], off: usize) -> f64 {
    f64::from_le_bytes(bytes[off..off + 8].try_into().unwrap())
}
