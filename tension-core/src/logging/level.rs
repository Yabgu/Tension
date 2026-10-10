//! Levels and thresholds.
//!
//! The six levels and their discriminants are the ABI's: the C enum
//! `tension_log_level_t` (`tension_logger.h`), the adapter table's `log_named`
//! level, and the guest's AssemblyScript `Level` all carry these numbers. They
//! are frozen for ABI version 1; a seventh level is a new header, not a new
//! discriminant.
//!
//! A [`Threshold`] is a *filter* concept, not a level: it is the smallest level
//! a logger will emit, plus the `off` sentinel. Filtering compares levels with
//! `>=`, which is why [`Level`] derives `Ord` in declaration order and why the
//! discriminants run least-severe first.

/// One severity, least severe first.
#[derive(Copy, Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[repr(u8)]
pub enum Level {
    Trace = 0,
    Debug = 1,
    Info = 2,
    Warn = 3,
    Error = 4,
    Fatal = 5,
}

impl Level {
    /// Every level, in order. The C enum and the AS enum are this list.
    pub const ALL: [Level; 6] = [
        Level::Trace,
        Level::Debug,
        Level::Info,
        Level::Warn,
        Level::Error,
        Level::Fatal,
    ];

    /// The level's layout tag: `TRACE`, `DEBUG`, `INFO`, `WARN`, `ERROR`,
    /// `FATAL`. Uppercase is the text and JSON layout's spelling and is part of
    /// the byte-identical-output promise, so it is not localisable.
    pub fn as_str(self) -> &'static str {
        match self {
            Level::Trace => "TRACE",
            Level::Debug => "DEBUG",
            Level::Info => "INFO",
            Level::Warn => "WARN",
            Level::Error => "ERROR",
            Level::Fatal => "FATAL",
        }
    }

    /// Parse a level name, case-insensitively. `warning` is accepted as a
    /// spelling of `warn` (the legacy `TensionCoreApi.log` vocabulary used it);
    /// nothing else is.
    pub fn parse(text: &str) -> Option<Level> {
        match text.trim().to_ascii_lowercase().as_str() {
            "trace" => Some(Level::Trace),
            "debug" => Some(Level::Debug),
            "info" => Some(Level::Info),
            "warn" | "warning" => Some(Level::Warn),
            "error" => Some(Level::Error),
            "fatal" => Some(Level::Fatal),
            _ => None,
        }
    }

    /// Map a `tension_log_level_t` value (0..=5) to a level, clamping a code
    /// outside that range to the nearest end. This is the free C ABI's
    /// vocabulary and the adapter table's `log_named` level.
    pub fn from_abi_code(code: i32) -> Level {
        match code {
            i32::MIN..=0 => Level::Trace,
            1 => Level::Debug,
            2 => Level::Info,
            3 => Level::Warn,
            4 => Level::Error,
            _ => Level::Fatal,
        }
    }

    /// Map the **legacy** `tension_core_api.log` level to the vocabulary:
    /// `0` debug, `1` info, `2` warning, `3` error. The old slot had no trace
    /// and no fatal, so `3` and anything outside the range is `error`.
    pub fn from_legacy_code(code: i32) -> Level {
        match code {
            0 => Level::Debug,
            1 => Level::Info,
            2 => Level::Warn,
            _ => Level::Error,
        }
    }
}

/// A filter threshold: the smallest level a logger emits, or `off`.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum Threshold {
    /// Emit nothing.
    Off,
    /// Emit `level` and everything more severe.
    At(Level),
}

impl Threshold {
    /// Parse a threshold: a level name or `off`.
    pub fn parse(text: &str) -> Option<Threshold> {
        let trimmed = text.trim();
        if trimmed.eq_ignore_ascii_case("off") {
            return Some(Threshold::Off);
        }
        Level::parse(trimmed).map(Threshold::At)
    }

    /// Whether a record at `level` passes this threshold.
    pub fn allows(self, level: Level) -> bool {
        match self {
            Threshold::Off => false,
            Threshold::At(threshold) => level >= threshold,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discriminants_are_the_abi() {
        // The C enum and the AS enum both read these numbers; a change here is
        // a change to `tension_logger.h` and to `assembly/log.ts`.
        assert_eq!(Level::Trace as u8, 0);
        assert_eq!(Level::Debug as u8, 1);
        assert_eq!(Level::Info as u8, 2);
        assert_eq!(Level::Warn as u8, 3);
        assert_eq!(Level::Error as u8, 4);
        assert_eq!(Level::Fatal as u8, 5);
        assert_eq!(Level::ALL.len(), 6);
    }

    #[test]
    fn levels_order_by_severity() {
        assert!(Level::Trace < Level::Debug);
        assert!(Level::Info < Level::Warn);
        assert!(Level::Error < Level::Fatal);
        assert_eq!(Level::ALL.iter().copied().max(), Some(Level::Fatal));
    }

    #[test]
    fn level_names_round_trip() {
        for level in Level::ALL {
            assert_eq!(Level::parse(level.as_str()), Some(level));
            assert_eq!(Level::parse(&level.as_str().to_ascii_lowercase()), Some(level));
        }
        assert_eq!(Level::parse("warning"), Some(Level::Warn));
        assert_eq!(Level::parse(" WARN "), Some(Level::Warn));
        assert_eq!(Level::parse("verbose"), None);
        assert_eq!(Level::parse(""), None);
    }

    #[test]
    fn abi_codes_clamp_at_both_ends() {
        assert_eq!(Level::from_abi_code(0), Level::Trace);
        assert_eq!(Level::from_abi_code(5), Level::Fatal);
        assert_eq!(Level::from_abi_code(-1), Level::Trace);
        assert_eq!(Level::from_abi_code(99), Level::Fatal);
        assert_eq!(Level::from_abi_code(i32::MIN), Level::Trace);
    }

    #[test]
    fn legacy_codes_map_onto_the_new_vocabulary() {
        assert_eq!(Level::from_legacy_code(0), Level::Debug);
        assert_eq!(Level::from_legacy_code(1), Level::Info);
        assert_eq!(Level::from_legacy_code(2), Level::Warn);
        assert_eq!(Level::from_legacy_code(3), Level::Error);
        // Outside the legacy range is an error, never a panic.
        assert_eq!(Level::from_legacy_code(4), Level::Error);
        assert_eq!(Level::from_legacy_code(-3), Level::Error);
    }

    #[test]
    fn thresholds_filter_by_severity() {
        let warn = Threshold::At(Level::Warn);
        assert!(!warn.allows(Level::Info));
        assert!(warn.allows(Level::Warn));
        assert!(warn.allows(Level::Fatal));
        assert!(!Threshold::Off.allows(Level::Fatal));
    }

    #[test]
    fn threshold_parses_level_names_and_off() {
        assert_eq!(Threshold::parse("info"), Some(Threshold::At(Level::Info)));
        assert_eq!(Threshold::parse("OFF"), Some(Threshold::Off));
        assert_eq!(Threshold::parse("off"), Some(Threshold::Off));
        assert_eq!(Threshold::parse("nope"), None);
    }
}
