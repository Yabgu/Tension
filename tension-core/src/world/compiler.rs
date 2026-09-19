//! The world compiler (P8c): the author's YAML in, the binary layout in
//! `tension-world/DESIGN.md` out — format_version 1.
//!
//! The pipeline is one pass: parse (the crate resolves anchors, rejects
//! duplicate keys, reports scan errors with line/column), validate against
//! the compiled-in vocabulary below, expand templates into literal
//! components and connections, then emit the bytes. The vocabulary lives
//! here as data and is cross-checked against `tension-world/schema.yaml`
//! by test (W13 in `tests/world_p8c.rs`) — the same discipline the
//! solver's compiled rules use.
//!
//! What this module deliberately is not: not the evaluator (P8d), not the
//! `source: "world"` wiring (P8e), not a CLI, and it never reads
//! `schema.yaml` at runtime.

use std::collections::HashMap;

use yaml_rust2::yaml::{Hash, Yaml};
use yaml_rust2::{ScanError, YamlLoader};

use super::errors::CompileError;

// ── the frozen numeric vocabulary (DESIGN.md §2, §4–§6) ─────────────────

const MAGIC: &[u8; 8] = b"TNSWORLD";
const FORMAT_VERSION: u16 = 1;
const HEADER_LEN: u32 = 40;
/// The `from`/`to` value gravity uses: no endpoints at all.
const NO_ENDPOINT: u32 = 0xFFFF_FFFF;

const TAG_POINT_MASS: u16 = 1;
const TAG_KINEMATIC: u16 = 2;
const TAG_ANCHOR: u16 = 3;
const TAG_SPRING: u16 = 1;
const TAG_PIN: u16 = 2;
const TAG_GRAVITY: u16 = 3;

/// The `tension-world/schema.yaml` version this compiler implements; an
/// author's `version:` must equal it, and it is what the compiled bytes
/// carry as `schema_version`.
pub const SCHEMA_VERSION: u16 = 1;

// ── the compiled-in catalog (schema.yaml, as data) ──────────────────────

/// The shape the compiler enforces for one field.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FieldShape {
    /// An f64 strictly greater than 0 (`mass`, `stiffness`).
    Positive,
    /// An f64 greater than or equal to 0 (`rest_length`, `damping`);
    /// optional ones default to 0.
    NonNegative,
    /// A `dimensions`-long list of numbers (`position`, `velocity`,
    /// `offset`, `acceleration`); optional ones default to all zeros.
    Vec,
    /// A component name (`from`, `to`).
    ComponentRef,
}

/// One field of a compiled-in type.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FieldSpec {
    pub name: &'static str,
    pub required: bool,
    pub shape: FieldShape,
}

/// One compiled-in type: its name and its fields, in declaration order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TypeSpec {
    pub name: &'static str,
    pub fields: &'static [FieldSpec],
}

/// Where a reserved name is expected to land when it is implemented.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReservedKind {
    Component,
    Connection,
}

/// A name the schema reserves but v1 does not implement.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReservedSpec {
    pub name: &'static str,
    pub kind: ReservedKind,
}

pub(crate) static COMPONENT_TYPES: &[TypeSpec] = &[
    TypeSpec {
        name: "point_mass",
        fields: &[
            FieldSpec { name: "mass", required: true, shape: FieldShape::Positive },
            FieldSpec { name: "position", required: false, shape: FieldShape::Vec },
            FieldSpec { name: "velocity", required: false, shape: FieldShape::Vec },
        ],
    },
    TypeSpec {
        name: "kinematic",
        fields: &[
            FieldSpec { name: "position", required: false, shape: FieldShape::Vec },
            FieldSpec { name: "velocity", required: false, shape: FieldShape::Vec },
        ],
    },
    TypeSpec {
        name: "anchor",
        fields: &[FieldSpec { name: "position", required: false, shape: FieldShape::Vec }],
    },
];

pub(crate) static CONNECTION_TYPES: &[TypeSpec] = &[
    TypeSpec {
        name: "spring",
        fields: &[
            FieldSpec { name: "from", required: true, shape: FieldShape::ComponentRef },
            FieldSpec { name: "to", required: true, shape: FieldShape::ComponentRef },
            FieldSpec { name: "stiffness", required: true, shape: FieldShape::Positive },
            FieldSpec { name: "rest_length", required: true, shape: FieldShape::NonNegative },
            FieldSpec { name: "damping", required: false, shape: FieldShape::NonNegative },
        ],
    },
    TypeSpec {
        name: "pin",
        fields: &[
            FieldSpec { name: "from", required: true, shape: FieldShape::ComponentRef },
            FieldSpec { name: "to", required: true, shape: FieldShape::ComponentRef },
            FieldSpec { name: "offset", required: true, shape: FieldShape::Vec },
        ],
    },
    TypeSpec {
        name: "gravity",
        fields: &[FieldSpec { name: "acceleration", required: true, shape: FieldShape::Vec }],
    },
];

pub(crate) static RESERVED_TYPES: &[ReservedSpec] = &[
    ReservedSpec { name: "collider", kind: ReservedKind::Component },
    ReservedSpec { name: "motor", kind: ReservedKind::Connection },
    ReservedSpec { name: "joint_angle", kind: ReservedKind::Connection },
    ReservedSpec { name: "contact", kind: ReservedKind::Connection },
];

fn type_spec(catalog: &'static [TypeSpec], name: &str) -> Option<&'static TypeSpec> {
    catalog.iter().find(|t| t.name == name)
}

/// The declared shape of one field — validation reads the table, never a
/// call-site literal, so the catalog cannot drift from the checks.
fn shape_of(spec: &TypeSpec, field: &str) -> FieldShape {
    spec.fields
        .iter()
        .find(|f| f.name == field)
        .unwrap_or_else(|| unreachable!("`{}` has no field `{field}`", spec.name))
        .shape
}

/// Resolve a `type:` name in component position: the catalog, then the
/// reserved table, then the wrong-catalog case, then unknown.
fn component_spec(name: &str) -> Result<&'static TypeSpec, CompileError> {
    if let Some(spec) = type_spec(COMPONENT_TYPES, name) {
        return Ok(spec);
    }
    Err(type_error(name, "component"))
}

fn connection_spec(name: &str) -> Result<&'static TypeSpec, CompileError> {
    if let Some(spec) = type_spec(CONNECTION_TYPES, name) {
        return Ok(spec);
    }
    Err(type_error(name, "connection"))
}

fn type_error(name: &str, position: &str) -> CompileError {
    if RESERVED_TYPES.iter().any(|r| r.name == name) {
        return CompileError::new(format!(
            "type `{name}` is reserved but not implemented in v1"
        ));
    }
    let other = if position == "component" { "connection" } else { "component" };
    let in_other = type_spec(if position == "component" { CONNECTION_TYPES } else { COMPONENT_TYPES }, name);
    if in_other.is_some() {
        return CompileError::new(format!(
            "`{name}` is a {other} type, not a {position} type"
        ));
    }
    CompileError::new(format!("unknown {position} type `{name}`"))
}

// ── the parsed world ────────────────────────────────────────────────────

struct World {
    dimensions: usize,
    components: Vec<Component>,
    connections: Vec<Connection>,
}

enum Component {
    PointMass { name: String, mass: f64, position: Vec<f64>, velocity: Vec<f64> },
    Kinematic { name: String, position: Vec<f64>, velocity: Vec<f64> },
    Anchor { name: String, position: Vec<f64> },
}

impl Component {
    fn name(&self) -> &str {
        match self {
            Component::PointMass { name, .. }
            | Component::Kinematic { name, .. }
            | Component::Anchor { name, .. } => name,
        }
    }
}

enum Connection {
    Spring { name: Option<String>, from: usize, to: usize, stiffness: f64, rest_length: f64, damping: f64 },
    Pin { name: Option<String>, from: usize, to: usize, offset: Vec<f64> },
    Gravity { name: Option<String>, acceleration: Vec<f64> },
}

impl Connection {
    fn name(&self) -> Option<&str> {
        match self {
            Connection::Spring { name, .. }
            | Connection::Pin { name, .. }
            | Connection::Gravity { name, .. } => name.as_deref(),
        }
    }
}

/// One file-wide name table: components and connections share one
/// namespace (`schema.yaml`: "Names are unique within the file").
#[derive(Default)]
struct NameMap {
    map: HashMap<String, NameOwner>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum NameOwner {
    Component(usize),
    Connection,
}

impl NameMap {
    fn insert_component(&mut self, name: &str, index: usize) -> Result<(), CompileError> {
        match self.map.get(name) {
            None => {
                self.map.insert(name.to_string(), NameOwner::Component(index));
                Ok(())
            }
            Some(NameOwner::Component(_)) => Err(CompileError::new(format!(
                "component name `{name}` appears twice"
            ))),
            Some(NameOwner::Connection) => Err(CompileError::new(format!(
                "component name `{name}` is already used by a connection"
            ))),
        }
    }

    fn insert_connection(&mut self, name: &str) -> Result<(), CompileError> {
        match self.map.get(name) {
            None => {
                self.map.insert(name.to_string(), NameOwner::Connection);
                Ok(())
            }
            Some(NameOwner::Connection) => Err(CompileError::new(format!(
                "connection name `{name}` appears twice"
            ))),
            Some(NameOwner::Component(_)) => Err(CompileError::new(format!(
                "connection name `{name}` is already used by a component"
            ))),
        }
    }

    fn component_index(&self, name: &str, label: &str) -> Result<usize, CompileError> {
        match self.map.get(name) {
            Some(NameOwner::Component(index)) => Ok(*index),
            Some(NameOwner::Connection) => Err(CompileError::new(format!(
                "{label} references `{name}`, which is a connection, not a component"
            ))),
            None => Err(CompileError::new(format!(
                "{label} references component `{name}`, which does not exist"
            ))),
        }
    }
}

/// A template declaration, validated once at declaration time — bodies
/// are checked eagerly (with parameter placeholders) so a typo fails even
/// if nothing invokes the template.
struct TemplateDecl {
    name: String,
    params: Vec<String>,
    components: Vec<Yaml>,
    connections: Vec<Yaml>,
}

/// A connection produced by an expansion, held until the connection pass
/// resolves its endpoints (which need every component to exist).
struct ProducedConn {
    entry: Yaml,
    template: String,
    index: usize,
}

// ── the entry point ─────────────────────────────────────────────────────

/// Compile the author's YAML into world bytes (`tension-world/DESIGN.md`,
/// format_version 1).
///
/// # Errors
///
/// Returns a [`CompileError`] naming what is wrong with the world: a
/// scan error with line/column, or a semantic error naming the offending
/// entry.
pub fn compile(yaml: &str) -> Result<Vec<u8>, CompileError> {
    let docs = YamlLoader::load_from_str(yaml).map_err(scan_error)?;
    if docs.len() != 1 {
        return Err(CompileError::new(format!(
            "expected exactly one YAML document, found {}",
            docs.len()
        )));
    }
    let world = parse_world(&docs[0])?;
    Ok(emit(&world))
}

fn scan_error(e: ScanError) -> CompileError {
    let m = e.marker();
    CompileError::at(format!("invalid YAML: {}", e.info()), m.line(), m.col())
}

// ── validation, in the schema's order ───────────────────────────────────

fn parse_world(root: &Yaml) -> Result<World, CompileError> {
    let map = match root {
        Yaml::Hash(map) => map,
        Yaml::Null | Yaml::BadValue => {
            return Err(CompileError::new(
                "the world is empty — expected a mapping with `version`, `dimensions`, \
                 `components`, and `connections`",
            ))
        }
        _ => return Err(CompileError::new("the world must be a YAML mapping")),
    };

    for (key, _) in map.iter() {
        let key = node_text(key);
        if !matches!(
            key.as_str(),
            "version" | "dimensions" | "components" | "connections" | "templates"
        ) {
            return Err(CompileError::new(format!("unknown top-level key `{key}`")));
        }
    }

    match required_key(map, "version")? {
        Yaml::Integer(1) => {}
        Yaml::Integer(other) => {
            return Err(CompileError::new(format!(
                "unsupported schema version {other} — this compiler implements schema version {SCHEMA_VERSION}"
            )))
        }
        _ => {
            return Err(CompileError::new(
                "`version` must be an integer (the schema version this world targets)",
            ))
        }
    }

    let dimensions = match required_key(map, "dimensions")? {
        Yaml::Integer(2) => 2usize,
        Yaml::Integer(3) => 3usize,
        _ => return Err(CompileError::new("`dimensions` must be 2 or 3")),
    };

    // Templates first: invocations in the components list look them up.
    let templates = match get(map, "templates") {
        None => Vec::new(),
        Some(Yaml::Array(list)) => parse_templates(list, dimensions)?,
        Some(_) => return Err(CompileError::new("`templates` must be a list")),
    };

    let component_list = match required_key(map, "components")? {
        Yaml::Array(list) => list,
        _ => return Err(CompileError::new("`components` must be a list")),
    };
    let connection_list = match required_key(map, "connections")? {
        Yaml::Array(list) => list,
        _ => return Err(CompileError::new("`connections` must be a list")),
    };

    // Components, in declaration order; an invocation's components take
    // the invocation's place (schema §templates), so dim follows the
    // final, expanded list.
    let mut components: Vec<Component> = Vec::new();
    let mut names = NameMap::default();
    let mut produced: Vec<ProducedConn> = Vec::new();
    for (i, entry) in component_list.iter().enumerate() {
        let ctx = format!("components[{i}]");
        let emap = expect_mapping(entry, &ctx)?;
        if get(emap, "template").is_some() {
            if get(emap, "type").is_some() {
                return Err(CompileError::new(format!(
                    "{ctx}: an entry takes `type` (a component) or `template` (an invocation), not both"
                )));
            }
            expand_invocation(emap, &ctx, &templates, dimensions, &mut components, &mut names, &mut produced)?;
        } else {
            let component = parse_component(emap, &ctx, dimensions)?;
            names.insert_component(component.name(), components.len())?;
            components.push(component);
        }
    }

    // Connections: the file's own list in declaration order, then the
    // expansions' in invocation order. The connection list has no
    // ordering semantics (schema §the top-level shape), so that is the
    // whole contract.
    let mut connections: Vec<Connection> = Vec::new();
    let mut seen_gravity = false;
    for (i, entry) in connection_list.iter().enumerate() {
        let ctx = format!("connections[{i}]");
        let emap = expect_mapping(entry, &ctx)?;
        if get(emap, "template").is_some() {
            return Err(CompileError::new(format!(
                "{ctx}: template invocations may only appear in `components`"
            )));
        }
        let shape = parse_connection_shape(emap, &ctx, dimensions)?;
        if let Some(name) = &shape.name {
            names.insert_connection(name)?;
        }
        connections.push(resolve_connection(shape, &names, &ctx, &mut seen_gravity)?);
    }
    for conn in &produced {
        let ctx = format!("template `{}` connection[{}]", conn.template, conn.index);
        let emap = expect_mapping(&conn.entry, &ctx)?;
        let shape = parse_connection_shape(emap, &ctx, dimensions)?;
        if let Some(name) = &shape.name {
            names.insert_connection(name)?;
        }
        connections.push(resolve_connection(shape, &names, &ctx, &mut seen_gravity)?);
    }

    Ok(World { dimensions, components, connections })
}

// ── components ──────────────────────────────────────────────────────────

fn parse_component(map: &Hash, ctx: &str, dimensions: usize) -> Result<Component, CompileError> {
    let type_name = match get(map, "type") {
        Some(Yaml::String(name)) => name.clone(),
        Some(_) => return Err(CompileError::new(format!("{ctx}: `type` must be a string"))),
        None => return Err(CompileError::new(format!("{ctx}: missing required field `type`"))),
    };
    let spec = component_spec(&type_name)?;

    let name = match get(map, "name") {
        Some(Yaml::String(name)) => plain_name(name)?,
        Some(_) => return Err(CompileError::new(format!("{ctx}: `name` must be a string"))),
        None => return Err(CompileError::new(format!("{ctx}: missing required field `name`"))),
    };
    let label = format!("component `{name}`");

    // Every key is either `type`/`name` or a field of the type.
    let mut seen: HashMap<&'static str, &Yaml> = HashMap::new();
    for (key, value) in map.iter() {
        let key = node_text(key);
        if key == "type" || key == "name" {
            continue;
        }
        let Some(field) = spec.fields.iter().find(|f| f.name == key) else {
            return Err(CompileError::new(format!(
                "{label} has unknown field `{key}`"
            )));
        };
        seen.insert(field.name, value);
    }
    for field in spec.fields.iter().filter(|f| f.required) {
        if !seen.contains_key(field.name) {
            return Err(CompileError::new(format!(
                "{label} is missing required field `{}`",
                field.name
            )));
        }
    }

    let vector = |field: &str| -> Result<Vec<f64>, CompileError> {
        match seen.get(field) {
            Some(value) => field_vec(value, &label, field, dimensions),
            None => Ok(vec![0.0; dimensions]),
        }
    };

    match spec.name {
        "point_mass" => {
            let mass = field_number(seen["mass"], &label, "mass", shape_of(spec, "mass"))?;
            Ok(Component::PointMass {
                name,
                mass,
                position: vector("position")?,
                velocity: vector("velocity")?,
            })
        }
        "kinematic" => Ok(Component::Kinematic {
            name,
            position: vector("position")?,
            velocity: vector("velocity")?,
        }),
        "anchor" => Ok(Component::Anchor { name, position: vector("position")? }),
        other => unreachable!("catalog type `{other}` has no constructor"),
    }
}

// ── connections ─────────────────────────────────────────────────────────

enum ConnectionData {
    Spring { stiffness: f64, rest_length: f64, damping: f64 },
    Pin { offset: Vec<f64> },
    Gravity { acceleration: Vec<f64> },
}

struct ConnectionShape {
    name: Option<String>,
    from: Option<String>,
    to: Option<String>,
    data: ConnectionData,
}

fn parse_connection_shape(
    map: &Hash,
    ctx: &str,
    dimensions: usize,
) -> Result<ConnectionShape, CompileError> {
    let type_name = match get(map, "type") {
        Some(Yaml::String(name)) => name.clone(),
        Some(_) => return Err(CompileError::new(format!("{ctx}: `type` must be a string"))),
        None => return Err(CompileError::new(format!("{ctx}: missing required field `type`"))),
    };
    let spec = connection_spec(&type_name)?;

    let name = match get(map, "name") {
        Some(Yaml::String(name)) => Some(plain_name(name)?),
        Some(_) => return Err(CompileError::new(format!("{ctx}: `name` must be a string"))),
        None => None,
    };
    let label = match &name {
        Some(name) => format!("connection `{name}`"),
        None => ctx.to_string(),
    };

    let mut seen: HashMap<&'static str, &Yaml> = HashMap::new();
    for (key, value) in map.iter() {
        let key = node_text(key);
        if key == "type" || key == "name" {
            continue;
        }
        let Some(field) = spec.fields.iter().find(|f| f.name == key) else {
            return Err(CompileError::new(format!(
                "{label} has unknown field `{key}`"
            )));
        };
        seen.insert(field.name, value);
    }
    for field in spec.fields.iter().filter(|f| f.required) {
        if !seen.contains_key(field.name) {
            return Err(CompileError::new(format!(
                "{label} is missing required field `{}`",
                field.name
            )));
        }
    }

    let endpoint = |field: &str| -> Result<Option<String>, CompileError> {
        match seen.get(field) {
            Some(Yaml::String(value)) => Ok(Some(plain_name(value)?)),
            Some(_) => Err(CompileError::new(format!("{label}: `{field}` must be a name"))),
            None => Ok(None),
        }
    };
    let from = endpoint("from")?;
    let to = endpoint("to")?;
    if let (Some(from), Some(to)) = (&from, &to) {
        if from == to {
            return Err(CompileError::new(format!("{label} has `from` == `to`")));
        }
    }

    let data = match spec.name {
        "spring" => ConnectionData::Spring {
            stiffness: field_number(seen["stiffness"], &label, "stiffness", shape_of(spec, "stiffness"))?,
            rest_length: field_number(seen["rest_length"], &label, "rest_length", shape_of(spec, "rest_length"))?,
            damping: match seen.get("damping") {
                Some(value) => field_number(value, &label, "damping", shape_of(spec, "damping"))?,
                None => 0.0,
            },
        },
        "pin" => ConnectionData::Pin {
            offset: field_vec(seen["offset"], &label, "offset", dimensions)?,
        },
        "gravity" => ConnectionData::Gravity {
            acceleration: field_vec(seen["acceleration"], &label, "acceleration", dimensions)?,
        },
        other => unreachable!("catalog type `{other}` has no constructor"),
    };

    Ok(ConnectionShape { name, from, to, data })
}

fn resolve_connection(
    shape: ConnectionShape,
    names: &NameMap,
    ctx: &str,
    seen_gravity: &mut bool,
) -> Result<Connection, CompileError> {
    let label = match &shape.name {
        Some(name) => format!("connection `{name}`"),
        None => ctx.to_string(),
    };
    // `from`/`to` presence for the binary kinds is enforced by the
    // required-field check in `parse_connection_shape`.
    let endpoint = |field: &'static str, value: &Option<String>| -> String {
        value
            .clone()
            .unwrap_or_else(|| unreachable!("`{field}` is required for this connection kind"))
    };
    match shape.data {
        ConnectionData::Spring { stiffness, rest_length, damping } => {
            let from = names.component_index(&endpoint("from", &shape.from), &label)?;
            let to = names.component_index(&endpoint("to", &shape.to), &label)?;
            Ok(Connection::Spring { name: shape.name, from, to, stiffness, rest_length, damping })
        }
        ConnectionData::Pin { offset } => {
            let from = names.component_index(&endpoint("from", &shape.from), &label)?;
            let to = names.component_index(&endpoint("to", &shape.to), &label)?;
            Ok(Connection::Pin { name: shape.name, from, to, offset })
        }
        ConnectionData::Gravity { acceleration } => {
            if *seen_gravity {
                return Err(CompileError::new("a second gravity connection is not allowed"));
            }
            *seen_gravity = true;
            Ok(Connection::Gravity { name: shape.name, acceleration })
        }
    }
}

// ── templates ───────────────────────────────────────────────────────────

#[derive(Clone, Copy, PartialEq, Eq)]
enum BodyKind {
    Component,
    Connection,
}

fn parse_templates(list: &[Yaml], dimensions: usize) -> Result<Vec<TemplateDecl>, CompileError> {
    let mut out: Vec<TemplateDecl> = Vec::new();
    for (i, entry) in list.iter().enumerate() {
        let ctx = format!("templates[{i}]");
        let map = expect_mapping(entry, &ctx)?;
        for (key, _) in map.iter() {
            let key = node_text(key);
            if !matches!(key.as_str(), "name" | "parameters" | "components" | "connections") {
                return Err(CompileError::new(format!(
                    "{ctx}: unknown field `{key}`"
                )));
            }
        }

        let name = match get(map, "name") {
            Some(Yaml::String(name)) => name.clone(),
            Some(_) => return Err(CompileError::new(format!("{ctx}: `name` must be a string"))),
            None => return Err(CompileError::new(format!("{ctx}: missing required field `name`"))),
        };
        if out.iter().any(|t| t.name == name) {
            return Err(CompileError::new(format!(
                "template name `{name}` appears twice"
            )));
        }

        let params: Vec<String> = match get(map, "parameters") {
            Some(Yaml::Array(items)) => items
                .iter()
                .map(|item| match item {
                    Yaml::String(param) => Ok(param.clone()),
                    _ => Err(CompileError::new(format!(
                        "template `{name}`: parameters must be names (strings)"
                    ))),
                })
                .collect::<Result<_, _>>()?,
            Some(_) => {
                return Err(CompileError::new(format!(
                    "template `{name}`: `parameters` must be a list of names"
                )))
            }
            None => Vec::new(),
        };
        for (j, param) in params.iter().enumerate() {
            if params[..j].contains(param) {
                return Err(CompileError::new(format!(
                    "template `{name}`: parameter `{param}` appears twice"
                )));
            }
        }

        let components = body_list(map, "components", &name)?.clone();
        let connections = body_list(map, "connections", &name)?.clone();

        // Bodies are validated once, here, with each parameter standing
        // for itself — a typo fails even if nothing invokes the template.
        let identity: Vec<(&str, &str)> =
            params.iter().map(|p| (p.as_str(), p.as_str())).collect();
        for (k, entry) in components.iter().enumerate() {
            let bctx = format!("template `{name}` component[{k}]");
            check_body_entry(entry, BodyKind::Component, &name, &params, &bctx)?;
            let substituted = substitute(entry, &identity);
            let bmap = expect_mapping(&substituted, &bctx)?;
            let _ = parse_component(bmap, &bctx, dimensions)?;
        }
        for (k, entry) in connections.iter().enumerate() {
            let bctx = format!("template `{name}` connection[{k}]");
            check_body_entry(entry, BodyKind::Connection, &name, &params, &bctx)?;
            let substituted = substitute(entry, &identity);
            let bmap = expect_mapping(&substituted, &bctx)?;
            let _ = parse_connection_shape(bmap, &bctx, dimensions)?;
        }

        out.push(TemplateDecl { name, params, components, connections });
    }
    Ok(out)
}

fn body_list<'a>(map: &'a Hash, key: &str, template_name: &str) -> Result<&'a Vec<Yaml>, CompileError> {
    match get(map, key) {
        Some(Yaml::Array(items)) => Ok(items),
        Some(_) => Err(CompileError::new(format!(
            "template `{template_name}`: `{key}` must be a list"
        ))),
        None => Err(CompileError::new(format!(
            "template `{template_name}`: missing required field `{key}`"
        ))),
    }
}

fn expand_invocation(
    map: &Hash,
    ctx: &str,
    templates: &[TemplateDecl],
    dimensions: usize,
    components: &mut Vec<Component>,
    names: &mut NameMap,
    produced: &mut Vec<ProducedConn>,
) -> Result<(), CompileError> {
    for (key, _) in map.iter() {
        let key = node_text(key);
        if !matches!(key.as_str(), "template" | "args") {
            return Err(CompileError::new(format!(
                "{ctx}: a template invocation takes `template` and `args`; there is no `{key}`"
            )));
        }
    }
    let template_name = match get(map, "template") {
        Some(Yaml::String(name)) => name.clone(),
        Some(_) => return Err(CompileError::new(format!("{ctx}: `template` must be a name"))),
        None => unreachable!("caller checked for the key"),
    };
    let decl = templates
        .iter()
        .find(|t| t.name == template_name)
        .ok_or_else(|| CompileError::new(format!("unknown template `{template_name}`")))?;

    let args: Vec<String> = match get(map, "args") {
        Some(Yaml::Array(items)) => items
            .iter()
            .map(|item| match item {
                Yaml::String(arg) => Ok(arg.clone()),
                _ => Err(CompileError::new(format!(
                    "{ctx}: template arguments must be names (strings)"
                ))),
            })
            .collect::<Result<_, _>>()?,
        Some(_) => {
            return Err(CompileError::new(format!(
                "{ctx}: `args` must be a list of names"
            )))
        }
        None => Vec::new(),
    };
    if args.len() != decl.params.len() {
        return Err(CompileError::new(format!(
            "template `{template_name}` takes {} argument{}, got {}",
            decl.params.len(),
            if decl.params.len() == 1 { "" } else { "s" },
            args.len()
        )));
    }
    for arg in &args {
        plain_name(arg).map_err(|_| {
            CompileError::new(format!(
                "{ctx}: template argument `{arg}` must be a plain name, not a parameter reference"
            ))
        })?;
    }

    let bindings: Vec<(&str, &str)> = decl
        .params
        .iter()
        .map(String::as_str)
        .zip(args.iter().map(String::as_str))
        .collect();

    for (k, entry) in decl.components.iter().enumerate() {
        let bctx = format!("template `{template_name}` component[{k}]");
        let substituted = substitute(entry, &bindings);
        let bmap = expect_mapping(&substituted, &bctx)?;
        let component = parse_component(bmap, &bctx, dimensions)?;
        names.insert_component(component.name(), components.len())?;
        components.push(component);
    }
    for (k, entry) in decl.connections.iter().enumerate() {
        produced.push(ProducedConn { entry: substitute(entry, &bindings), template: template_name.clone(), index: k });
    }
    Ok(())
}

/// Body-entry rules that hold before substitution: a body is mappings;
/// a binary connection's endpoints must be parameters; every `$name` must
/// be a declared parameter; no nested invocations.
fn check_body_entry(
    entry: &Yaml,
    kind: BodyKind,
    template_name: &str,
    params: &[String],
    ctx: &str,
) -> Result<(), CompileError> {
    let map = expect_mapping(entry, ctx)?;
    if get(map, "template").is_some() {
        return Err(CompileError::new(format!(
            "template `{template_name}`: nested template invocations are not supported in v1"
        )));
    }
    if kind == BodyKind::Connection {
        for field in ["from", "to"] {
            if let Some(value) = get(map, field) {
                let is_parameter = matches!(value, Yaml::String(s) if s.starts_with('$'));
                if !is_parameter {
                    return Err(CompileError::new(format!(
                        "template `{template_name}`: connection endpoint `{}` must be a parameter (`$name`)",
                        node_text(value)
                    )));
                }
            }
        }
    }
    for field in ["name", "from", "to"] {
        if let Some(Yaml::String(value)) = get(map, field) {
            if let Some(param) = value.strip_prefix('$') {
                if !params.iter().any(|p| p == param) {
                    return Err(CompileError::new(format!(
                        "template `{template_name}` references undeclared parameter `${param}`"
                    )));
                }
            }
        }
    }
    Ok(())
}

/// Replace `$parameter` in the name positions (`name`, `from`, `to`) with
/// the bound argument. Everything else passes through untouched; an
/// unbound `$name` (impossible after `check_body_entry`) would survive to
/// fail loudly in the ordinary name checks.
fn substitute(entry: &Yaml, bindings: &[(&str, &str)]) -> Yaml {
    let Yaml::Hash(map) = entry else {
        return entry.clone();
    };
    let mut out = Hash::new();
    for (key, value) in map.iter() {
        let text = node_text(key);
        let value = match value {
            Yaml::String(s) if matches!(text.as_str(), "name" | "from" | "to") => match s.strip_prefix('$') {
                Some(param) => match bindings.iter().find(|(p, _)| *p == param) {
                    Some((_, arg)) => Yaml::String((*arg).to_string()),
                    None => value.clone(),
                },
                None => value.clone(),
            },
            _ => value.clone(),
        };
        out.insert(key.clone(), value);
    }
    Yaml::Hash(out)
}

// ── field primitives ────────────────────────────────────────────────────

fn field_number(
    value: &Yaml,
    label: &str,
    field: &str,
    shape: FieldShape,
) -> Result<f64, CompileError> {
    let Some(number) = number_of(value) else {
        return Err(CompileError::new(format!("{label}: `{field}` must be a number")));
    };
    match shape {
        FieldShape::Positive if !(number > 0.0) => {
            Err(CompileError::new(format!("{label}: `{field}` must be > 0")))
        }
        FieldShape::NonNegative if !(number >= 0.0) => {
            Err(CompileError::new(format!("{label}: `{field}` must be >= 0")))
        }
        _ => Ok(number),
    }
}

fn field_vec(value: &Yaml, label: &str, field: &str, dimensions: usize) -> Result<Vec<f64>, CompileError> {
    let bad = || {
        CompileError::new(format!(
            "{label}: `{field}` must be a list of exactly {dimensions} numbers"
        ))
    };
    let Yaml::Array(items) = value else {
        return Err(bad());
    };
    if items.len() != dimensions {
        return Err(bad());
    }
    items.iter().map(|item| number_of(item).ok_or_else(bad)).collect()
}

/// The core-schema number reading the loader itself uses: integers,
/// reals, and YAML 1.2's `.inf`/`.nan` spellings.
fn number_of(value: &Yaml) -> Option<f64> {
    match value {
        Yaml::Integer(i) => Some(*i as f64),
        Yaml::Real(s) => match s.as_str() {
            ".inf" | ".Inf" | ".INF" | "+.inf" | "+.Inf" | "+.INF" => Some(f64::INFINITY),
            "-.inf" | "-.Inf" | "-.INF" => Some(f64::NEG_INFINITY),
            ".nan" | ".NaN" | ".NAN" => Some(f64::NAN),
            _ => s.parse::<f64>().ok(),
        },
        _ => None,
    }
}

/// Names outside a template body may not be parameter references; those
/// are the template facility's spelling, not the world's.
fn plain_name(name: &str) -> Result<String, CompileError> {
    if let Some(param) = name.strip_prefix('$') {
        return Err(CompileError::new(format!(
            "`${param}` is a template parameter reference; those are valid only inside a template body"
        )));
    }
    Ok(name.to_string())
}

// ── YAML conveniences ───────────────────────────────────────────────────

fn get<'a>(map: &'a Hash, key: &str) -> Option<&'a Yaml> {
    map.get(&Yaml::String(key.to_string()))
}

fn required_key<'a>(map: &'a Hash, key: &str) -> Result<&'a Yaml, CompileError> {
    get(map, key).ok_or_else(|| {
        CompileError::new(format!("missing required top-level key `{key}`"))
    })
}

fn expect_mapping<'a>(entry: &'a Yaml, ctx: &str) -> Result<&'a Hash, CompileError> {
    match entry {
        Yaml::Hash(map) => Ok(map),
        _ => Err(CompileError::new(format!("{ctx} must be a mapping"))),
    }
}

/// How a scalar reads inside a message: its text for strings, the number
/// for numbers, a stand-in for everything else.
fn node_text(node: &Yaml) -> String {
    match node {
        Yaml::String(s) => s.clone(),
        Yaml::Integer(i) => i.to_string(),
        Yaml::Real(r) => r.clone(),
        Yaml::Boolean(b) => b.to_string(),
        Yaml::Null | Yaml::BadValue => "null".to_string(),
        _ => "<complex>".to_string(),
    }
}

// ── emission (DESIGN.md §4–§7) ──────────────────────────────────────────

fn component_entry_size(component: &Component, dimensions: usize) -> u32 {
    let d = dimensions as u32;
    match component {
        Component::PointMass { .. } => 16 + 16 * d,
        Component::Kinematic { .. } => 8 + 16 * d,
        Component::Anchor { .. } => 8 + 8 * d,
    }
}

fn connection_entry_size(connection: &Connection, dimensions: usize) -> u32 {
    let d = dimensions as u32;
    match connection {
        Connection::Spring { .. } => 40,
        Connection::Pin { .. } => 16 + 8 * d,
        Connection::Gravity { .. } => 16 + 8 * d,
    }
}

fn emit(world: &World) -> Vec<u8> {
    let dimensions = world.dimensions;
    debug_assert!(dimensions == 2 || dimensions == 3);

    // The name table: component names in declaration order, then the
    // named connections, in declaration order (§7).
    let mut names: Vec<&str> = world.components.iter().map(Component::name).collect();
    names.extend(world.connections.iter().filter_map(Connection::name));
    // Offsets of each name *within* the table; the entries below store
    // them made absolute — DESIGN.md §3 fixes every offset as from file
    // start, never from a section.
    let mut name_offsets: Vec<u32> = Vec::with_capacity(names.len());
    let mut name_bytes_len = 0u32;
    for name in &names {
        name_offsets.push(name_bytes_len);
        name_bytes_len += 4 + name.len() as u32;
    }

    let component_table_offset = HEADER_LEN;
    let connection_table_offset = component_table_offset
        + world
            .components
            .iter()
            .map(|c| component_entry_size(c, dimensions))
            .sum::<u32>();
    let tables_end = connection_table_offset
        + world
            .connections
            .iter()
            .map(|c| connection_entry_size(c, dimensions))
            .sum::<u32>();
    let name_table_offset = if names.is_empty() { 0 } else { tables_end };

    let mut out = Vec::with_capacity((tables_end + name_bytes_len) as usize);

    // header (§4) — 40 bytes
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&FORMAT_VERSION.to_le_bytes());
    out.extend_from_slice(&SCHEMA_VERSION.to_le_bytes());
    out.push(dimensions as u8);
    out.push(0); // flags — reserved, must be 0
    out.extend_from_slice(&0u16.to_le_bytes()); // reserved
    out.extend_from_slice(&(world.components.len() as u32).to_le_bytes());
    out.extend_from_slice(&(world.connections.len() as u32).to_le_bytes());
    out.extend_from_slice(&component_table_offset.to_le_bytes());
    out.extend_from_slice(&connection_table_offset.to_le_bytes());
    out.extend_from_slice(&name_table_offset.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes()); // reserved2
    debug_assert_eq!(out.len(), HEADER_LEN as usize);

    // component table (§5) — declaration order IS state-slot order
    for (index, component) in world.components.iter().enumerate() {
        let name_offset = name_table_offset + name_offsets[index];
        match component {
            Component::PointMass { mass, position, velocity, .. } => {
                out.extend_from_slice(&TAG_POINT_MASS.to_le_bytes());
                out.extend_from_slice(&0u16.to_le_bytes());
                out.extend_from_slice(&name_offset.to_le_bytes());
                out.extend_from_slice(&mass.to_le_bytes());
                for v in position.iter().chain(velocity.iter()) {
                    out.extend_from_slice(&v.to_le_bytes());
                }
            }
            Component::Kinematic { position, velocity, .. } => {
                out.extend_from_slice(&TAG_KINEMATIC.to_le_bytes());
                out.extend_from_slice(&0u16.to_le_bytes());
                out.extend_from_slice(&name_offset.to_le_bytes());
                for v in position.iter().chain(velocity.iter()) {
                    out.extend_from_slice(&v.to_le_bytes());
                }
            }
            Component::Anchor { position, .. } => {
                out.extend_from_slice(&TAG_ANCHOR.to_le_bytes());
                out.extend_from_slice(&0u16.to_le_bytes());
                out.extend_from_slice(&name_offset.to_le_bytes());
                for v in position {
                    out.extend_from_slice(&v.to_le_bytes());
                }
            }
        }
    }

    // connection table (§6)
    let mut next_name = world.components.len();
    for connection in world.connections.iter() {
        let name_offset = match connection.name() {
            Some(_) => {
                let offset = name_table_offset + name_offsets[next_name];
                next_name += 1;
                offset
            }
            None => 0,
        };
        match connection {
            Connection::Spring { from, to, stiffness, rest_length, damping, .. } => {
                out.extend_from_slice(&TAG_SPRING.to_le_bytes());
                out.extend_from_slice(&0u16.to_le_bytes());
                out.extend_from_slice(&name_offset.to_le_bytes());
                out.extend_from_slice(&(*from as u32).to_le_bytes());
                out.extend_from_slice(&(*to as u32).to_le_bytes());
                out.extend_from_slice(&stiffness.to_le_bytes());
                out.extend_from_slice(&rest_length.to_le_bytes());
                out.extend_from_slice(&damping.to_le_bytes());
            }
            Connection::Pin { from, to, offset, .. } => {
                out.extend_from_slice(&TAG_PIN.to_le_bytes());
                out.extend_from_slice(&0u16.to_le_bytes());
                out.extend_from_slice(&name_offset.to_le_bytes());
                out.extend_from_slice(&(*from as u32).to_le_bytes());
                out.extend_from_slice(&(*to as u32).to_le_bytes());
                for v in offset {
                    out.extend_from_slice(&v.to_le_bytes());
                }
            }
            Connection::Gravity { acceleration, .. } => {
                out.extend_from_slice(&TAG_GRAVITY.to_le_bytes());
                out.extend_from_slice(&0u16.to_le_bytes());
                out.extend_from_slice(&name_offset.to_le_bytes());
                out.extend_from_slice(&NO_ENDPOINT.to_le_bytes());
                out.extend_from_slice(&NO_ENDPOINT.to_le_bytes());
                for v in acceleration {
                    out.extend_from_slice(&v.to_le_bytes());
                }
            }
        }
    }

    // name table (§7) — length-prefixed UTF-8, no terminator, no padding
    if !names.is_empty() {
        debug_assert_eq!(out.len(), name_table_offset as usize);
        for name in &names {
            out.extend_from_slice(&(name.len() as u32).to_le_bytes());
            out.extend_from_slice(name.as_bytes());
        }
    }

    debug_assert_eq!(out.len(), (tables_end + name_bytes_len) as usize);
    out
}
