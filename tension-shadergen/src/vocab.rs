//! The resource vocabulary: what a slot is *called* once it becomes an
//! attribute.
//!
//! The generator knows slots and semantics; it does not know what a host's
//! asset pipeline calls them. Naming lives behind this trait so a renderer's
//! vocabulary can be supplied from the adapter that owns the renderer, while the
//! generator stays a pure function of the layout.
//!
//! The default here is deliberately neutral (`a_position`, `a_texcoord0`, …).
//! OGRE's HLMS names the first texture-coordinate set differently, and that
//! mapping belongs to `tension-ogre`'s adapter — the component that knows it is
//! talking to OGRE — not to this crate, which is why no OGRE-specific name
//! appears in this file.

use crate::Slot;

/// How a renderer names the attributes it consumes.
pub trait Vocabulary {
    /// The attribute name for a vertex slot. Stable for the life of the
    /// process; a `'static` name keeps the generated string cheap and makes an
    /// accidental format-string injection impossible.
    fn attribute(&self, slot: Slot) -> &'static str;
}

/// The generator's own vocabulary: descriptive, renderer-agnostic names.
pub struct NeutralVocabulary;

impl Vocabulary for NeutralVocabulary {
    fn attribute(&self, slot: Slot) -> &'static str {
        match slot {
            Slot::Position => "a_position",
            Slot::TexCoord(0) => "a_texcoord0",
            Slot::TexCoord(1) => "a_texcoord1",
            // The same set index space, exhausted: still a valid name rather
            // than a panic, because a layout the host cannot serve should
            // return `-ENOSYS` upstream, not abort the process here.
            Slot::TexCoord(_) => "a_texcoord",
            Slot::TexPage => "a_texpage",
            Slot::Color => "a_color",
            Slot::Normal => "a_normal",
            Slot::Tangent => "a_tangent",
            Slot::Binormal => "a_binormal",
        }
    }
}
