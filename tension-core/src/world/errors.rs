//! The world compiler's error type.
//!
//! A [`CompileError`] is a message plus, where the YAML parser reports
//! one, a line/column location. Scan errors — malformed YAML, duplicate
//! keys in a mapping, an undefined alias — carry `yaml-rust2`'s marker;
//! semantic errors instead name the offending entry (`component `bob``,
//! `connections[2]`, `template `pendulum``) because the crate's loaded
//! value tree does not attach spans to nodes. That is a deliberate P8c
//! boundary: reaching spans on the semantic path would mean re-writing
//! the crate's loader over its event API, and the compiler is not the
//! place for a second YAML implementation.

use std::fmt;

/// A location in the source YAML: 1-based line and column, as the parser
/// reports them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Span {
    /// 1-based line number.
    pub line: usize,
    /// 1-based column number.
    pub col: usize,
}

/// Why a world did not compile.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompileError {
    message: String,
    span: Option<Span>,
}

impl CompileError {
    pub(crate) fn new(message: impl Into<String>) -> Self {
        CompileError {
            message: message.into(),
            span: None,
        }
    }

    pub(crate) fn at(message: impl Into<String>, line: usize, col: usize) -> Self {
        CompileError {
            message: message.into(),
            span: Some(Span { line, col }),
        }
    }

    /// The message, without any location suffix.
    #[must_use]
    pub fn message(&self) -> &str {
        &self.message
    }

    /// The source location, when the YAML parser reported one. Semantic
    /// errors (everything after a successful parse) report `None`.
    #[must_use]
    pub fn span(&self) -> Option<Span> {
        self.span
    }
}

impl fmt::Display for CompileError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.span {
            Some(s) => write!(f, "{} (line {}, column {})", self.message, s.line, s.col),
            None => f.write_str(&self.message),
        }
    }
}

impl std::error::Error for CompileError {}
