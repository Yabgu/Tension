//! The world module: the compiler (P8c) that turns the author's YAML into
//! the compiled bytes, and the evaluator (P8d) that reads those bytes and
//! computes f(t, y).
//!
//! `compile` is the whole surface that produces bytes:
//!
//! ```
//! let bytes = tension_core::world::compile(
//!     "version: 1\ndimensions: 2\ncomponents: []\nconnections: []\n",
//! )
//! .expect("an empty world compiles");
//! assert_eq!(bytes.len(), 40); // the header, and nothing else
//! ```
//!
//! The vocabulary the compiler accepts is compiled-in data ([`TypeSpec`],
//! [`ReservedSpec`]) rather than a runtime read of `schema.yaml`; the
//! drift test (W13 in `tests/world_p8c.rs`) crosses the two, the same
//! discipline the solver's compiled rules use. Nothing here is FFI, and
//! nothing here reads a file: the compiler takes text and returns bytes.
//!
//! [`World`] is the other half: `World::load` validates a compiled file
//! against `tension-world/DESIGN.md`'s structural rules and borrows it;
//! `World::eval` computes f(t, y) — pure, allocation-free, no integration
//! (that is the solver's job). The evaluator's force conventions are §12
//! of the format note.

mod compiler;
mod eval;
mod errors;

pub use compiler::{
    compile, FieldShape, FieldSpec, ReservedKind, ReservedSpec, TypeSpec, SCHEMA_VERSION,
};
pub use errors::{CompileError, Span};
pub use eval::{World, WorldError};

/// The compiled-in component catalog, in schema order.
#[must_use]
pub fn component_types() -> &'static [TypeSpec] {
    compiler::COMPONENT_TYPES
}

/// The compiled-in connection catalog, in schema order.
#[must_use]
pub fn connection_types() -> &'static [TypeSpec] {
    compiler::CONNECTION_TYPES
}

/// The names the schema reserves but v1 does not implement.
#[must_use]
pub fn reserved_types() -> &'static [ReservedSpec] {
    compiler::RESERVED_TYPES
}
