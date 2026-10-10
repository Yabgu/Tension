//! The logging subsystem.
//!
//! Logging is a **verb**, not a wire shape: the host owns one logger — its
//! level, filter, layout, sink, and configuration — and every language hands it
//! a `(level, logger name, message)` triple through a thin adapter. The arena's
//! `layout_hash` does not move, the adapter ABI gains only appended slots, and
//! nothing here knows what a `tension_value` is.
//!
//! ```text
//!   guest (AssemblyScript)      tension::io::log  ─┐
//!   native adapters (C/C++)     tension_core_api  ─┼─▶  Record ─▶ Layout ─▶ Sink (stderr/file)
//!   the host (Rust)             logging::log      ─┘
//! ```
//!
//! The layout is applied **once**, in this module, whichever language produced
//! the record — so the same `(level, name, message)` yields the same bytes on
//! stderr whether it came from C++ or from the guest.
//!
//! ## Modules
//!
//! - [`level`] — the six levels and filter thresholds.
//! - [`record`] — one event, before layout.
//! - [`layout`] — text and JSON rendering.
//! - [`time`] — RFC-3339 UTC, and the injectable clock.
//! - [`sink`] — the destination (stderr, file, null, memory).
//! - [`filter`] — per-logger-name thresholds.
//! - [`config`] — the `--log-*` grammar.
//! - [`logger`] — the core and the process-global instance.
//! - `ffi` — the `#[no_mangle]` C ABI (`tension_log`, `tension_log_structured`).
//!
//! ## Using it from Rust
//!
//! ```no_run
//! use tension_core::logging::{self, Config, Level};
//!
//! let mut config = Config::default();
//! config.set_level_spec("ogre:debug").expect("parses");
//! logging::init(config).expect("the sink opens");
//! logging::log(Level::Info, "core", "ready");
//! ```
//!
//! ## CLI and precedence
//!
//! `--log-level <SPEC>`, `--log-format <text|json>`, `--log-file <PATH>`.
//! Environment fallback: `TENSION_LOG_LEVEL`, `TENSION_LOG_FORMAT`,
//! `TENSION_LOG_FILE`. **CLI beats the environment, which beats the defaults**
//! (`info`, `text`, stderr).

mod config;
mod filter;
mod layout;
mod level;
mod logger;
mod record;
mod sink;
mod time;

pub use config::{parse_level_spec, Config, ConfigError, LevelSpec};
pub use layout::Format;
pub use level::{Level, Threshold};
pub use logger::{emit, enabled, flush, init, is_initialized, log, LoggerCore};
pub use record::Record;
pub use sink::{Sink, SinkError, SinkKind};
