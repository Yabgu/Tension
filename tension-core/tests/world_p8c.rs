//! P8c tests: the world compiler — YAML in, `tension-world/DESIGN.md`'s
//! bytes out.
//!
//! W1–W12 are the phase brief's cases. W13 is the drift check the brief
//! requires in C5: the compiler's compiled-in rules, exposed read-only by
//! `tension_core::world`, against `tension-world/schema.yaml` — the same
//! discipline the solver's compiled rules use (its T20).
//!
//! The decoders below read bytes at the documented offsets only; they are
//! test-side verifiers, not the P8d evaluator.

use std::path::PathBuf;

use tension_core::world::{self, compile, CompileError, FieldShape, ReservedKind};

// ── a test-side decoder for DESIGN.md §4–§7 ─────────────────────────────

fn u16_at(b: &[u8], off: usize) -> u16 {
    u16::from_le_bytes(b[off..off + 2].try_into().unwrap())
}

fn u32_at(b: &[u8], off: usize) -> u32 {
    u32::from_le_bytes(b[off..off + 4].try_into().unwrap())
}

fn f64_at(b: &[u8], off: usize) -> f64 {
    f64::from_le_bytes(b[off..off + 8].try_into().unwrap())
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect::<Vec<_>>().join(" ")
}

#[derive(Debug)]
struct Header {
    magic: [u8; 8],
    format_version: u16,
    schema_version: u16,
    dimensions: u8,
    flags: u8,
    reserved: u16,
    component_count: u32,
    connection_count: u32,
    component_table_offset: u32,
    connection_table_offset: u32,
    name_table_offset: u32,
    reserved2: u32,
}

fn header(b: &[u8]) -> Header {
    assert!(b.len() >= 40, "a world is at least its 40-byte header");
    Header {
        magic: b[0..8].try_into().unwrap(),
        format_version: u16_at(b, 8),
        schema_version: u16_at(b, 10),
        dimensions: b[12],
        flags: b[13],
        reserved: u16_at(b, 14),
        component_count: u32_at(b, 16),
        connection_count: u32_at(b, 20),
        component_table_offset: u32_at(b, 24),
        connection_table_offset: u32_at(b, 28),
        name_table_offset: u32_at(b, 32),
        reserved2: u32_at(b, 36),
    }
}

/// One component-table entry: its header fields plus every f64 that
/// follows, in §5's layout order.
#[derive(Debug)]
struct CompEntry {
    tag: u16,
    reserved: u16,
    name_offset: u32,
    values: Vec<f64>,
    size: u32,
}

fn component_entries(b: &[u8]) -> Vec<CompEntry> {
    let h = header(b);
    let d = h.dimensions as usize;
    let mut out = Vec::new();
    let mut off = h.component_table_offset as usize;
    for _ in 0..h.component_count {
        let tag = u16_at(b, off);
        let (payload, size) = match tag {
            1 => (1 + 2 * d, 16 + 16 * d), // mass, position, velocity
            2 => (2 * d, 8 + 16 * d),      // position, velocity
            3 => (d, 8 + 8 * d),           // position
            other => panic!("unknown component tag {other}"),
        };
        let values = (0..payload).map(|i| f64_at(b, off + 8 + 8 * i)).collect();
        out.push(CompEntry {
            tag,
            reserved: u16_at(b, off + 2),
            name_offset: u32_at(b, off + 4),
            values,
            size: size as u32,
        });
        off += size;
    }
    out
}

/// One connection-table entry, same shape.
#[derive(Debug)]
struct ConnEntry {
    tag: u16,
    reserved: u16,
    name_offset: u32,
    from: u32,
    to: u32,
    values: Vec<f64>,
    size: u32,
}

fn connection_entries(b: &[u8]) -> Vec<ConnEntry> {
    let h = header(b);
    let d = h.dimensions as usize;
    let mut out = Vec::new();
    let mut off = h.connection_table_offset as usize;
    for _ in 0..h.connection_count {
        let tag = u16_at(b, off);
        let (payload, size) = match tag {
            1 => (3, 40),             // stiffness, rest_length, damping
            2 => (d, 16 + 8 * d),     // offset
            3 => (d, 16 + 8 * d),     // acceleration
            other => panic!("unknown connection tag {other}"),
        };
        let values = (0..payload).map(|i| f64_at(b, off + 16 + 8 * i)).collect();
        out.push(ConnEntry {
            tag,
            reserved: u16_at(b, off + 2),
            name_offset: u32_at(b, off + 4),
            from: u32_at(b, off + 8),
            to: u32_at(b, off + 12),
            values,
            size: size as u32,
        });
        off += size;
    }
    out
}

fn name_at(b: &[u8], offset: u32) -> String {
    assert_ne!(offset, 0, "offset 0 means unnamed, not a name");
    let off = offset as usize;
    let len = u32_at(b, off) as usize;
    String::from_utf8(b[off + 4..off + 4 + len].to_vec()).expect("names are UTF-8")
}

/// The dim the schema's rule derives from the decoded component table:
/// point_mass and kinematic contribute 2 × dimensions, anchor contributes 0.
fn dim_of(b: &[u8]) -> usize {
    let d = header(b).dimensions as usize;
    component_entries(b)
        .iter()
        .map(|c| match c.tag {
            1 | 2 => 2 * d,
            3 => 0,
            other => panic!("unknown component tag {other}"),
        })
        .sum()
}

// ── compile helpers ─────────────────────────────────────────────────────

fn world_bytes(yaml: &str) -> Vec<u8> {
    match compile(yaml) {
        Ok(bytes) => bytes,
        Err(e) => panic!("expected a compiled world, got: {e}\nyaml:\n{yaml}"),
    }
}

fn compile_err(yaml: &str) -> CompileError {
    match compile(yaml) {
        Ok(bytes) => panic!("expected a compile error, got {} bytes\nyaml:\n{yaml}", bytes.len()),
        Err(e) => e,
    }
}

#[track_caller]
fn assert_msg(yaml: &str, want: &str) {
    let e = compile_err(yaml);
    assert_eq!(e.message(), want, "yaml:\n{yaml}");
}

// ═══ W1 ═════════════════════════════════════════════════════════════════
// The minimal world: one point_mass, dimensions 2, no connections. Every
// header field, the one entry, the name table, and the total length.

#[test]
fn w1_minimal_world_header_and_entry() {
    let yaml = r#"version: 1
dimensions: 2
components:
  - type: point_mass
    name: ball
    mass: 2.5
connections: []
"#;
    let b = world_bytes(yaml);
    let h = header(&b);

    assert_eq!(h.magic, *b"TNSWORLD");
    assert_eq!(h.format_version, 1);
    assert_eq!(h.schema_version, 1);
    assert_eq!(h.dimensions, 2);
    assert_eq!(h.flags, 0, "flags are reserved and must be 0");
    assert_eq!(h.reserved, 0);
    assert_eq!(h.component_count, 1);
    assert_eq!(h.connection_count, 0);
    assert_eq!(h.component_table_offset, 40);
    assert_eq!(h.connection_table_offset, 88, "40 + one 48-byte point_mass");
    assert_eq!(h.name_table_offset, 88);
    assert_eq!(h.reserved2, 0);

    let c = &component_entries(&b)[0];
    assert_eq!(c.tag, 1, "point_mass");
    assert_eq!(c.reserved, 0);
    assert_eq!(c.name_offset, 88);
    assert_eq!(c.size, 48, "16 + 16·d at d = 2");
    assert_eq!(c.values, vec![2.5, 0.0, 0.0, 0.0, 0.0], "mass, position, velocity");

    assert_eq!(name_at(&b, c.name_offset), "ball");
    assert_eq!(b.len(), 96, "header + table + [len]\"ball\"");

    println!("W1 header: {}", hex(&b[..40]));
    println!("W1 total: {} bytes; name table: {}", b.len(), hex(&b[88..]));
}

// ═══ W2 ═════════════════════════════════════════════════════════════════
// Two point_masses and a spring: both tables decoded at documented offsets.

#[test]
fn w2_components_and_spring_decode() {
    let yaml = r#"version: 1
dimensions: 2
components:
  - type: point_mass
    name: a
    mass: 1.0
  - type: point_mass
    name: b
    mass: 2.0
connections:
  - type: spring
    name: link
    from: a
    to: b
    stiffness: 10.0
    rest_length: 1.5
"#;
    let b = world_bytes(yaml);
    let h = header(&b);
    assert_eq!(h.component_count, 2);
    assert_eq!(h.connection_count, 1);
    assert_eq!(h.component_table_offset, 40);
    assert_eq!(h.connection_table_offset, 136, "40 + 48 + 48");
    assert_eq!(h.name_table_offset, 176, "136 + the 40-byte spring");

    let cs = component_entries(&b);
    assert_eq!(cs.len(), 2);
    assert_eq!(cs[0].tag, 1);
    assert_eq!(cs[0].values, vec![1.0, 0.0, 0.0, 0.0, 0.0]);
    assert_eq!(cs[1].tag, 1);
    assert_eq!(cs[1].values, vec![2.0, 0.0, 0.0, 0.0, 0.0]);
    assert_eq!(name_at(&b, cs[0].name_offset), "a");
    assert_eq!(name_at(&b, cs[1].name_offset), "b");
    assert_eq!(cs[0].name_offset, 176);
    assert_eq!(cs[1].name_offset, 181);

    let ns = connection_entries(&b);
    assert_eq!(ns.len(), 1);
    assert_eq!(ns[0].tag, 1, "spring");
    assert_eq!(ns[0].reserved, 0);
    assert_eq!(ns[0].from, 0, "`a` is component 0");
    assert_eq!(ns[0].to, 1, "`b` is component 1");
    assert_eq!(ns[0].values, vec![10.0, 1.5, 0.0], "stiffness, rest_length, damping default");
    assert_eq!(ns[0].size, 40);
    assert_eq!(name_at(&b, ns[0].name_offset), "link");
    assert_eq!(ns[0].name_offset, 186);

    assert_eq!(b.len(), 194, "176 + 5 + 5 + 8 bytes of names");
}

// ═══ W3 ═════════════════════════════════════════════════════════════════
// All three connection types in one 3D world; gravity carries no endpoints.

#[test]
fn w3_all_three_connection_types() {
    let yaml = r#"version: 1
dimensions: 3
components:
  - type: point_mass
    name: p
    mass: 1.0
  - type: anchor
    name: hub
    position: [0.0, 0.0, 0.0]
connections:
  - type: spring
    name: s
    from: p
    to: hub
    stiffness: 4.0
    rest_length: 2.0
    damping: 0.5
  - type: pin
    name: pn
    from: p
    to: hub
    offset: [1.0, 0.0, 0.0]
  - type: gravity
    name: g
    acceleration: [0.0, -9.81, 0.0]
"#;
    let b = world_bytes(yaml);
    let h = header(&b);
    assert_eq!(h.dimensions, 3);
    assert_eq!(h.component_table_offset, 40);
    assert_eq!(h.connection_table_offset, 136, "40 + 64 + 32");
    assert_eq!(h.name_table_offset, 256, "136 + 40 + 40 + 40");

    let cs = component_entries(&b);
    assert_eq!(cs[0].tag, 1);
    assert_eq!(cs[0].size, 64, "16 + 16·3");
    assert_eq!(cs[1].tag, 3, "anchor");
    assert_eq!(cs[1].size, 32, "8 + 8·3");
    assert_eq!(cs[1].values, vec![0.0, 0.0, 0.0]);

    let ns = connection_entries(&b);
    assert_eq!(ns.len(), 3);
    assert_eq!(ns[0].tag, 1);
    assert_eq!(ns[0].values, vec![4.0, 2.0, 0.5]);
    assert_eq!(ns[1].tag, 2, "pin");
    assert_eq!(ns[1].size, 40);
    assert_eq!(ns[1].values, vec![1.0, 0.0, 0.0]);
    assert_eq!(ns[2].tag, 3, "gravity");
    assert_eq!(ns[2].from, 0xFFFF_FFFF, "gravity has no `from`");
    assert_eq!(ns[2].to, 0xFFFF_FFFF, "gravity has no `to`");
    assert_eq!(ns[2].values, vec![0.0, -9.81, 0.0]);

    assert_eq!(name_at(&b, ns[2].name_offset), "g");
    assert_eq!(b.len(), 284, "256 + 5 + 7 + 5 + 6 + 5 bytes of names");
}

// ═══ W4 ═════════════════════════════════════════════════════════════════
// Reserved names are rejected with the message the schema demands: the
// type is named, and v1 is named as the reason.

#[test]
fn w4_reserved_types_are_rejected_by_name() {
    assert_msg(
        r#"version: 1
dimensions: 2
components:
  - type: collider
    name: c
connections: []
"#,
        "type `collider` is reserved but not implemented in v1",
    );
    assert_msg(
        r#"version: 1
dimensions: 2
components: []
connections:
  - type: motor
"#,
        "type `motor` is reserved but not implemented in v1",
    );
}

// ═══ W5 ═════════════════════════════════════════════════════════════════
// Unknown vocabulary, structural refusals — and the parser's own errors,
// which carry line/column (duplicate keys included).

#[test]
fn w5_unknown_types_and_structural_refusals() {
    assert_msg(
        r#"version: 1
dimensions: 2
components:
  - type: foo
    name: c
connections: []
"#,
        "unknown component type `foo`",
    );
    assert_msg(
        r#"version: 1
dimensions: 2
components: []
connections:
  - type: bar
"#,
        "unknown connection type `bar`",
    );
    // A known name in the wrong position says so rather than playing dumb.
    assert_msg(
        r#"version: 1
dimensions: 2
components:
  - type: spring
    name: c
connections: []
"#,
        "`spring` is a connection type, not a component type",
    );
    assert_msg(
        r#"version: 1
dimensions: 2
world: nope
components: []
connections: []
"#,
        "unknown top-level key `world`",
    );
    assert_msg(
        r#"version: 2
dimensions: 2
components: []
connections: []
"#,
        "unsupported schema version 2 — this compiler implements schema version 1",
    );
    assert_msg(
        r#"version: 1
dimensions: 2
components: []
"#,
        "missing required top-level key `connections`",
    );
    assert_msg("", "expected exactly one YAML document, found 0");
    assert_msg("# nothing here\n", "expected exactly one YAML document, found 0");
    assert_msg(
        "version: 1\n---\nversion: 1\n",
        "expected exactly one YAML document, found 2",
    );

    // The parser's errors carry the crate's marker: the offending line,
    // as C3 asks.
    let e = compile_err(
        r#"version: 1
dimensions: 2
components:
  - type: point_mass
    name: b
    mass: 1.0
    mass: 2.0
connections: []
"#,
    );
    assert!(
        e.message().contains("duplicated key in mapping"),
        "got: {e}"
    );
    assert_eq!(e.span(), Some(world::Span { line: 7, col: 10 }));
}

// ═══ W6 ═════════════════════════════════════════════════════════════════
// Field-level validation: missing, ill-typed, out of range, wrong length.

#[test]
fn w6_field_validation() {
    let body = |fields: &str| {
        format!(
            "version: 1\ndimensions: 2\ncomponents:\n  - type: point_mass\n    name: bob\n{fields}connections: []\n"
        )
    };
    assert_msg(
        &body(""),
        "component `bob` is missing required field `mass`",
    );
    assert_msg(
        &body("    mass: 0.0\n"),
        "component `bob`: `mass` must be > 0",
    );
    assert_msg(
        &body("    mass: \"heavy\"\n"),
        "component `bob`: `mass` must be a number",
    );
    assert_msg(
        &body("    mass: 1.0\n    position: [1.0, 2.0, 3.0]\n"),
        "component `bob`: `position` must be a list of exactly 2 numbers",
    );
    assert_msg(
        &body("    mass: 1.0\n    velocity: [1.0, \"fast\"]\n"),
        "component `bob`: `velocity` must be a list of exactly 2 numbers",
    );
    assert_msg(
        &body("    mass: 1.0\n    colour: red\n"),
        "component `bob` has unknown field `colour`",
    );
    assert_msg(
        "version: 1\ndimensions: 2\ncomponents:\n  - type: anchor\nconnections: []\n",
        "components[0]: missing required field `name`",
    );
    assert_msg(
        "version: 1\ndimensions: 2\ncomponents:\n  - type: 3\n    name: c\nconnections: []\n",
        "components[0]: `type` must be a string",
    );
    assert_msg(
        r#"version: 1
dimensions: 2
components:
  - type: point_mass
    name: a
    mass: 1.0
  - type: anchor
    name: b
connections:
  - type: spring
    name: s1
    from: a
    to: b
    rest_length: 1.0
"#,
        "connection `s1` is missing required field `stiffness`",
    );
    assert_msg(
        r#"version: 1
dimensions: 2
components:
  - type: point_mass
    name: a
    mass: 1.0
  - type: anchor
    name: b
connections:
  - type: spring
    name: s1
    from: a
    to: b
    stiffness: 1.0
    rest_length: -1.0
"#,
        "connection `s1`: `rest_length` must be >= 0",
    );
    assert_msg(
        r#"version: 1
dimensions: 2
components:
  - type: point_mass
    name: a
    mass: 1.0
  - type: anchor
    name: b
connections:
  - type: spring
    name: s1
    from: a
    to: b
    stiffness: 1.0
    rest_length: 1.0
    damping: -0.5
"#,
        "connection `s1`: `damping` must be >= 0",
    );
    // A world can also mix dimensions by no other route: a 3-vector in a
    // 2-world is the vector error above; `dimensions: 4` is not a world.
    assert_msg(
        "version: 1\ndimensions: 4\ncomponents: []\nconnections: []\n",
        "`dimensions` must be 2 or 3",
    );
}

// ═══ W7 ═════════════════════════════════════════════════════════════════
// Names are unique within the file — components and connections share one
// namespace (schema §the top-level shape).

#[test]
fn w7_duplicate_names() {
    assert_msg(
        r#"version: 1
dimensions: 2
components:
  - type: anchor
    name: bob
  - type: anchor
    name: bob
connections: []
"#,
        "component name `bob` appears twice",
    );
    assert_msg(
        r#"version: 1
dimensions: 2
components:
  - type: point_mass
    name: ball
    mass: 1.0
  - type: anchor
    name: base
connections:
  - type: spring
    name: ball
    from: ball
    to: base
    stiffness: 1.0
    rest_length: 1.0
"#,
        "connection name `ball` is already used by a component",
    );
    assert_msg(
        r#"version: 1
dimensions: 2
components:
  - type: point_mass
    name: a
    mass: 1.0
  - type: anchor
    name: b
connections:
  - type: spring
    name: s1
    from: a
    to: b
    stiffness: 1.0
    rest_length: 1.0
  - type: pin
    name: s1
    from: a
    to: b
    offset: [0.0, 0.0]
"#,
        "connection name `s1` appears twice",
    );
}

// ═══ W8 ═════════════════════════════════════════════════════════════════
// A spring or pin whose `from` equals its `to` is refused; so is a
// connection to a component that does not exist.

#[test]
fn w8_self_connection_and_missing_reference() {
    assert_msg(
        r#"version: 1
dimensions: 2
components:
  - type: point_mass
    name: a
    mass: 1.0
connections:
  - type: spring
    name: s1
    from: a
    to: a
    stiffness: 1.0
    rest_length: 1.0
"#,
        "connection `s1` has `from` == `to`",
    );
    // Unnamed connections are labelled by position.
    assert_msg(
        r#"version: 1
dimensions: 2
components:
  - type: point_mass
    name: a
    mass: 1.0
connections:
  - type: pin
    from: a
    to: a
    offset: [0.0, 0.0]
"#,
        "connections[0] has `from` == `to`",
    );
    assert_msg(
        r#"version: 1
dimensions: 2
components:
  - type: point_mass
    name: a
    mass: 1.0
connections:
  - type: spring
    name: s1
    from: a
    to: nowhere
    stiffness: 1.0
    rest_length: 1.0
"#,
        "connection `s1` references component `nowhere`, which does not exist",
    );
}

// ═══ W9 ═════════════════════════════════════════════════════════════════
// The world has one gravitational field.

#[test]
fn w9_second_gravity_is_refused() {
    assert_msg(
        r#"version: 1
dimensions: 2
components: []
connections:
  - type: gravity
    acceleration: [0.0, -9.8]
  - type: gravity
    acceleration: [0.0, -1.6]
"#,
        "a second gravity connection is not allowed",
    );
}

// ═══ W10 ════════════════════════════════════════════════════════════════
// A template declared once and invoked once: the expansion's components
// take the invocation's place, its connections join the list, and dim
// follows the expanded components.

#[test]
fn w10_template_expands_in_place() {
    let yaml = r#"version: 1
dimensions: 2
templates:
  - name: pair
    parameters: [left, right]
    components:
      - type: point_mass
        name: $left
        mass: 1.0
      - type: anchor
        name: $right
    connections:
      - type: spring
        from: $left
        to: $right
        stiffness: 10.0
        rest_length: 1.0
components:
  - template: pair
    args: [base, tip]
connections: []
"#;
    let b = world_bytes(yaml);
    let h = header(&b);
    assert_eq!(h.component_count, 2, "the expansion's two components");
    assert_eq!(h.connection_count, 1, "the expansion's one connection");
    assert_eq!(h.component_table_offset, 40);
    assert_eq!(h.connection_table_offset, 112, "40 + 48 + 24");
    assert_eq!(h.name_table_offset, 152, "112 + the 40-byte spring");

    let cs = component_entries(&b);
    assert_eq!(cs[0].tag, 1, "point_mass from the body");
    assert_eq!(cs[1].tag, 3, "anchor from the body");
    assert_eq!(name_at(&b, cs[0].name_offset), "base");
    assert_eq!(name_at(&b, cs[1].name_offset), "tip");

    let ns = connection_entries(&b);
    assert_eq!(ns[0].tag, 1);
    assert_eq!(ns[0].name_offset, 0, "the body's connection is unnamed");
    assert_eq!(ns[0].from, 0, "`$left` resolved to the component's index");
    assert_eq!(ns[0].to, 1);
    assert_eq!(ns[0].values, vec![10.0, 1.0, 0.0]);

    assert_eq!(dim_of(&b), 4, "point_mass contributes 2·2; the anchor 0");
    assert_eq!(b.len(), 167, "152 + 8 + 7 bytes of names");

    // Expansion is checked, not guessed: arity, parameters, endpoints,
    // unknown names, nesting, and invocations out of position.
    assert_msg(
        r#"version: 1
dimensions: 2
templates:
  - name: pair
    parameters: [left, right]
    components:
      - type: anchor
        name: $left
    connections: []
components:
  - template: pair
    args: [solo]
connections: []
"#,
        "template `pair` takes 2 arguments, got 1",
    );
    assert_msg(
        r#"version: 1
dimensions: 2
components:
  - template: truss
    args: []
connections: []
"#,
        "unknown template `truss`",
    );
    assert_msg(
        r#"version: 1
dimensions: 2
templates:
  - name: pair
    parameters: [left]
    components:
      - type: anchor
        name: $nope
    connections: []
components: []
connections: []
"#,
        "template `pair` references undeclared parameter `$nope`",
    );
    assert_msg(
        r#"version: 1
dimensions: 2
templates:
  - name: pair
    parameters: [left, right]
    components:
      - type: anchor
        name: $left
      - type: anchor
        name: $right
    connections:
      - type: spring
        from: base
        to: $right
        stiffness: 1.0
        rest_length: 1.0
components: []
connections: []
"#,
        "template `pair`: connection endpoint `base` must be a parameter (`$name`)",
    );
    assert_msg(
        r#"version: 1
dimensions: 2
templates:
  - name: pair
    parameters: [left, right]
    components:
      - type: anchor
        name: $left
      - type: anchor
        name: $right
    connections:
      - type: spring
        from: $left
        to: $right
        stiffness: 1.0
        rest_length: 1.0
components:
  - template: pair
    args: [base, tip]
  - template: pair
    args: [base, tip]
connections: []
"#,
        // The second expansion reuses names: the uniqueness rule is the
        // template facility's whole safety net (schema §templates).
        "component name `base` appears twice",
    );
    assert_msg(
        r#"version: 1
dimensions: 2
components: []
connections:
  - template: pair
    args: [a, b]
"#,
        "connections[0]: template invocations may only appear in `components`",
    );
}

// ═══ W11 ════════════════════════════════════════════════════════════════
// dim derivation: the arithmetic `source: "world"` will run at create time.

#[test]
fn w11_dim_derivation() {
    // Empty: dim 0, and no name table at all.
    let b = world_bytes("version: 1\ndimensions: 2\ncomponents: []\nconnections: []\n");
    let h = header(&b);
    assert_eq!(h.component_count, 0);
    assert_eq!(h.connection_count, 0);
    assert_eq!(h.name_table_offset, 0, "an empty name table is offset 0");
    assert_eq!(dim_of(&b), 0);
    assert_eq!(b.len(), 40, "the header and nothing else");

    // Anchors only: components exist, dim is still 0.
    let yaml = r#"version: 1
dimensions: 2
components:
  - type: anchor
    name: a1
  - type: anchor
    name: a2
connections: []
"#;
    let b = world_bytes(yaml);
    assert_eq!(header(&b).component_count, 2);
    assert_eq!(dim_of(&b), 0, "anchors contribute no state");
    assert_eq!(b.len(), 100, "88 + 6 + 6 bytes of names");

    // Two state-carrying components in 3D: 2·3 + 2·3.
    let yaml = r#"version: 1
dimensions: 3
components:
  - type: point_mass
    name: p
    mass: 3.0
    velocity: [0.0, 0.0, 1.0]
  - type: kinematic
    name: k
    position: [1.0, 2.0, 3.0]
connections: []
"#;
    let b = world_bytes(yaml);
    assert_eq!(header(&b).component_count, 2);
    assert_eq!(dim_of(&b), 12, "2·3 (point_mass) + 2·3 (kinematic)");
    let cs = component_entries(&b);
    assert_eq!(cs[0].values, vec![3.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0], "mass, position, velocity");
    assert_eq!(cs[1].values, vec![1.0, 2.0, 3.0, 0.0, 0.0, 0.0], "position, velocity default");
    assert_eq!(b.len(), 170, "160 + 5 + 5 bytes of names");
}

// ═══ W12 ════════════════════════════════════════════════════════════════
// The name table: order, byte lengths (not char counts), unnamed
// connections absent, offsets dense from the table's start.

#[test]
fn w12_name_table_order_and_bytes() {
    let yaml = r#"version: 1
dimensions: 2
components:
  - type: point_mass
    name: café
    mass: 1.0
  - type: anchor
    name: pivot
connections:
  - type: spring
    name: link
    from: café
    to: pivot
    stiffness: 1.0
    rest_length: 1.0
  - type: gravity
    acceleration: [0.0, -9.8]
"#;
    let b = world_bytes(yaml);
    let h = header(&b);
    assert_eq!(h.name_table_offset, 184, "112 + 40 + 32");
    assert_eq!(b.len(), 210, "184 + (4+5) + (4+5) + (4+4)");

    let cs = component_entries(&b);
    let ns = connection_entries(&b);

    // Component names first (declaration order), then named connections.
    assert_eq!(cs[0].name_offset, 184);
    assert_eq!(cs[1].name_offset, 193);
    assert_eq!(ns[0].name_offset, 202);
    assert_eq!(ns[1].name_offset, 0, "an unnamed connection is offset 0");

    assert_eq!(name_at(&b, cs[0].name_offset), "café");
    assert_eq!(name_at(&b, cs[1].name_offset), "pivot");
    assert_eq!(name_at(&b, ns[0].name_offset), "link");

    // UTF-8: `café` is four characters and five bytes, and the table
    // counts bytes.
    assert_eq!("café".chars().count(), 4);
    assert_eq!("café".len(), 5);
    assert_eq!(u32_at(&b, 184), 5, "the length prefix is the byte length");

    // The offsets are dense: each name starts where the previous' bytes end.
    assert_eq!(u32_at(&b, 184) as usize + 4 + 184, 193);
    assert_eq!(u32_at(&b, 193) as usize + 4 + 193, 202);
    assert_eq!(u32_at(&b, 202) as usize + 4 + 202, b.len());
}

// ═══ W13 ════════════════════════════════════════════════════════════════
// Drift: the compiled-in rules vs tension-world/schema.yaml. Every name,
// field, requiredness, and shape the schema declares must be what the
// compiler enforces — and every reserved name must answer with the
// reserved message, not "unknown".

fn schema_text() -> String {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("tension-world")
        .join("schema.yaml");
    std::fs::read_to_string(path).expect("tension-world/schema.yaml readable")
}

#[derive(Debug)]
struct SchemaField {
    name: String,
    required: bool,
    shape: FieldShape,
}

#[derive(Debug)]
struct SchemaType {
    name: String,
    fields: Vec<SchemaField>,
}

fn unquote(s: &str) -> String {
    s.trim().trim_matches('"').to_string()
}

/// Scan a `component_types:` / `connection_types:` block out of the
/// schema text, line by line — the same discipline the solver's test uses
/// on its schema.
fn schema_types(text: &str, block: &str) -> Vec<SchemaType> {
    let mut out: Vec<SchemaType> = Vec::new();
    let mut cur: Option<SchemaType> = None;
    let mut inside = false;
    for line in text.lines() {
        if !inside {
            if line.starts_with(&format!("{block}:")) {
                inside = true;
            }
            continue;
        }
        if line.trim().is_empty() || line.trim_start().starts_with('#') {
            continue;
        }
        if !line.starts_with(' ') {
            break; // the next top-level section
        }
        if let Some(rest) = line.strip_prefix("  - name: ") {
            if let Some(done) = cur.take() {
                out.push(done);
            }
            cur = Some(SchemaType { name: rest.trim().to_string(), fields: Vec::new() });
            continue;
        }
        let Some(current) = cur.as_mut() else { continue };
        let trimmed = line.trim_start();
        let Some(brace) = trimmed.find('{') else { continue };
        let name = trimmed[..trimmed.find(':').expect("a field line has a colon")].trim().to_string();
        let inner = &trimmed[brace + 1..trimmed.rfind('}').expect("a field line closes its brace")];
        let (mut kind, mut constraint, mut required) = (String::new(), String::new(), false);
        for part in inner.split(',') {
            let part = part.trim();
            if let Some(v) = part.strip_prefix("type:") {
                kind = unquote(v);
            } else if let Some(v) = part.strip_prefix("constraint:") {
                constraint = unquote(v);
            } else if part == "required: true" {
                required = true;
            }
        }
        let shape = match (kind.as_str(), constraint.as_str()) {
            ("f64", "> 0") => FieldShape::Positive,
            ("f64", ">= 0") => FieldShape::NonNegative,
            ("vec f64[dimensions]", _) => FieldShape::Vec,
            ("component-name", _) => FieldShape::ComponentRef,
            other => panic!("schema field `{name}` has an unknown shape: {other:?}"),
        };
        current.fields.push(SchemaField { name, required, shape });
    }
    if let Some(done) = cur.take() {
        out.push(done);
    }
    out
}

/// Scan the `reserved_types:` block: (name, kind) in declaration order.
fn schema_reserved(text: &str) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    let mut pending: Option<String> = None;
    let mut inside = false;
    for line in text.lines() {
        if !inside {
            if line.starts_with("reserved_types:") {
                inside = true;
            }
            continue;
        }
        if line.trim().is_empty() || line.trim_start().starts_with('#') {
            continue;
        }
        if !line.starts_with(' ') {
            break;
        }
        if let Some(rest) = line.strip_prefix("  - name: ") {
            pending = Some(rest.trim().to_string());
        } else if let Some(kind) = line.trim().strip_prefix("kind: ") {
            out.push((
                pending.take().expect("a `kind:` line follows a name"),
                kind.trim().to_string(),
            ));
        }
    }
    assert!(pending.is_none(), "the last reserved entry has no kind");
    out
}

#[test]
fn w13_compiled_rules_match_schema() {
    let text = schema_text();

    let declared: u16 = text
        .lines()
        .find_map(|line| line.strip_prefix("schema_version: "))
        .expect("schema.yaml declares schema_version")
        .trim()
        .parse()
        .expect("schema_version is an integer");
    assert_eq!(declared, world::SCHEMA_VERSION, "schema_version agrees");

    // ── the component catalog ──
    let schema = schema_types(&text, "component_types");
    let compiled = world::component_types();
    assert!(!schema.is_empty(), "the schema declares component types");
    assert_eq!(schema.len(), compiled.len(), "component type count");
    for (want, got) in schema.iter().zip(compiled) {
        assert_eq!(want.name, got.name, "component names, in order");
        assert_eq!(want.fields.len(), got.fields.len(), "{}: field count", got.name);
        for (wf, gf) in want.fields.iter().zip(got.fields) {
            assert_eq!(wf.name, gf.name, "{}: field order", got.name);
            assert_eq!(wf.required, gf.required, "{}: `{}` requiredness", got.name, gf.name);
            assert_eq!(wf.shape, gf.shape, "{}: `{}` shape", got.name, gf.name);
        }
        // Behaviorally: a minimal world with this type compiles.
        let extra = match got.name {
            "point_mass" => "    mass: 1.0\n",
            _ => "",
        };
        let yaml = format!(
            "version: 1\ndimensions: 2\ncomponents:\n  - type: {}\n    name: c\n{extra}connections: []\n",
            got.name
        );
        assert!(compile(&yaml).is_ok(), "declared component type `{}` compiles", got.name);
    }

    // ── the connection catalog ──
    let schema = schema_types(&text, "connection_types");
    let compiled = world::connection_types();
    assert!(!schema.is_empty(), "the schema declares connection types");
    assert_eq!(schema.len(), compiled.len(), "connection type count");
    for (want, got) in schema.iter().zip(compiled) {
        assert_eq!(want.name, got.name, "connection names, in order");
        assert_eq!(want.fields.len(), got.fields.len(), "{}: field count", got.name);
        for (wf, gf) in want.fields.iter().zip(got.fields) {
            assert_eq!(wf.name, gf.name, "{}: field order", got.name);
            assert_eq!(wf.required, gf.required, "{}: `{}` requiredness", got.name, gf.name);
            assert_eq!(wf.shape, gf.shape, "{}: `{}` shape", got.name, gf.name);
        }
        // Behaviorally: a minimal world with this connection compiles.
        let yaml = match got.name {
            "spring" => "version: 1\ndimensions: 2\ncomponents:\n  - type: point_mass\n    name: a\n    mass: 1.0\n  - type: anchor\n    name: b\nconnections:\n  - type: spring\n    from: a\n    to: b\n    stiffness: 1.0\n    rest_length: 1.0\n".to_string(),
            "pin" => "version: 1\ndimensions: 2\ncomponents:\n  - type: point_mass\n    name: a\n    mass: 1.0\n  - type: anchor\n    name: b\nconnections:\n  - type: pin\n    from: a\n    to: b\n    offset: [0.0, 0.0]\n".to_string(),
            "gravity" => "version: 1\ndimensions: 2\ncomponents: []\nconnections:\n  - type: gravity\n    acceleration: [0.0, -9.8]\n".to_string(),
            other => panic!("schema declares a connection type this test does not know: {other}"),
        };
        assert!(compile(&yaml).is_ok(), "declared connection type `{}` compiles", got.name);
    }

    // ── the reserved table: names, kinds, and the exact message ──
    let schema = schema_reserved(&text);
    let compiled = world::reserved_types();
    assert_eq!(schema.len(), compiled.len(), "reserved name count");
    for ((sname, skind), got) in schema.iter().zip(compiled) {
        assert_eq!(sname.as_str(), got.name, "reserved names, in order");
        let kind = match got.kind {
            ReservedKind::Component => "component",
            ReservedKind::Connection => "connection",
        };
        assert_eq!(skind, kind, "{sname}: reserved kind");
        let yaml = match got.kind {
            ReservedKind::Component => format!(
                "version: 1\ndimensions: 2\ncomponents:\n  - type: {sname}\n    name: c\nconnections: []\n"
            ),
            ReservedKind::Connection => format!(
                "version: 1\ndimensions: 2\ncomponents: []\nconnections:\n  - type: {sname}\n"
            ),
        };
        assert_msg(
            &yaml,
            &format!("type `{sname}` is reserved but not implemented in v1"),
        );
    }
}
