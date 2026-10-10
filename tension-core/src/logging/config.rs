//! Configuration: the parsed `--log-*` flags, and the level-spec grammar.
//!
//! The grammar is log4j's, cut down to one flag. `--log-level` takes a
//! comma-separated list whose entries are either a bare level (setting the
//! global default) or `NAME:LEVEL` (setting one namespace):
//!
//! ```text
//! --log-level=info
//! --log-level=trace
//! --log-level=off
//! --log-level=ai:debug,ogre:warn
//! --log-level=audio:warn,audio:real:debug
//! ```
//!
//! The split is at the **last** colon, so `audio:real:debug` names the logger
//! `audio:real`. A name with no level (`audio:real`) is refused rather than
//! guessed at: the level is what the flag is for.

use std::path::PathBuf;

use super::layout::Format;
use super::level::{Level, Threshold};
use super::sink::SinkKind;

/// Everything the logger needs to start.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Config {
    /// The fallback threshold, for names with no override.
    pub global: Threshold,
    /// Per-name thresholds, in the order they were set.
    pub overrides: Vec<(String, Threshold)>,
    pub format: Format,
    pub sink: SinkKind,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            global: Threshold::At(Level::Info),
            overrides: Vec::new(),
            format: Format::Text,
            sink: SinkKind::Stderr,
        }
    }
}

impl Config {
    /// Merge a `--log-level` spec into this config. A bare level moves the
    /// global default; `NAME:LEVEL` sets an override, and a later setting for
    /// the same name replaces an earlier one.
    pub fn set_level_spec(&mut self, spec: &str) -> Result<(), ConfigError> {
        let parsed = parse_level_spec(spec)?;
        if let Some(global) = parsed.global {
            self.global = global;
        }
        for (name, threshold) in parsed.overrides {
            if let Some(existing) = self.overrides.iter_mut().find(|(known, _)| *known == name) {
                existing.1 = threshold;
            } else {
                self.overrides.push((name, threshold));
            }
        }
        Ok(())
    }

    /// Set the layout from `--log-format`.
    pub fn set_format(&mut self, text: &str) -> Result<(), ConfigError> {
        self.format = Format::parse(text).ok_or_else(|| ConfigError::UnknownFormat {
            value: text.trim().to_string(),
        })?;
        Ok(())
    }

    /// Set the sink from `--log-file`.
    pub fn set_file(&mut self, path: PathBuf) {
        self.sink = SinkKind::File(path);
    }
}

/// A parsed level spec: the optional global default and the overrides.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LevelSpec {
    pub global: Option<Threshold>,
    pub overrides: Vec<(String, Threshold)>,
}

/// Parse a `--log-level` value.
pub fn parse_level_spec(spec: &str) -> Result<LevelSpec, ConfigError> {
    let mut parsed = LevelSpec::default();
    for entry in spec.split(',') {
        let entry = entry.trim();
        if entry.is_empty() {
            return Err(ConfigError::EmptyEntry {
                spec: spec.to_string(),
            });
        }
        match entry.rsplit_once(':') {
            Some((name, level)) => {
                let name = name.trim();
                if name.is_empty() {
                    return Err(ConfigError::MissingName {
                        entry: entry.to_string(),
                    });
                }
                let threshold =
                    Threshold::parse(level).ok_or_else(|| ConfigError::UnknownLevel {
                        entry: entry.to_string(),
                        value: level.trim().to_string(),
                    })?;
                parsed.overrides.push((name.to_string(), threshold));
            }
            None => {
                let threshold = Threshold::parse(entry).ok_or_else(|| ConfigError::UnknownLevel {
                    entry: entry.to_string(),
                    value: entry.to_string(),
                })?;
                parsed.global = Some(threshold);
            }
        }
    }
    Ok(parsed)
}

/// Why a log option was refused.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ConfigError {
    /// A `--log-level` entry was empty (a stray comma, or an empty value).
    EmptyEntry { spec: String },
    /// `NAME:LEVEL` with an empty name.
    MissingName { entry: String },
    /// A level name that is not a level.
    UnknownLevel { entry: String, value: String },
    /// A `--log-format` that is neither `text` nor `json`.
    UnknownFormat { value: String },
}

impl std::fmt::Display for ConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ConfigError::EmptyEntry { spec } => write!(
                f,
                "`--log-level {spec}` has an empty entry; expected `LEVEL` or `NAME:LEVEL`"
            ),
            ConfigError::MissingName { entry } => write!(
                f,
                "`--log-level {entry}` has no logger name before the colon"
            ),
            ConfigError::UnknownLevel { entry, value } => write!(
                f,
                "`--log-level {entry}`: `{value}` is not a level \
                 (trace, debug, info, warn, error, fatal, off)"
            ),
            ConfigError::UnknownFormat { value } => write!(
                f,
                "`--log-format {value}`: expected `text` or `json`"
            ),
        }
    }
}

impl std::error::Error for ConfigError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_default_config_is_info_text_stderr() {
        let config = Config::default();
        assert_eq!(config.global, Threshold::At(Level::Info));
        assert!(config.overrides.is_empty());
        assert_eq!(config.format, Format::Text);
        assert_eq!(config.sink, SinkKind::Stderr);
    }

    #[test]
    fn a_bare_level_moves_the_default() {
        let spec = parse_level_spec("debug").expect("parses");
        assert_eq!(spec.global, Some(Threshold::At(Level::Debug)));
        assert!(spec.overrides.is_empty());

        let off = parse_level_spec("off").expect("parses");
        assert_eq!(off.global, Some(Threshold::Off));
    }

    #[test]
    fn name_level_entries_become_overrides() {
        let spec = parse_level_spec("ai:debug,ogre:warn").expect("parses");
        assert_eq!(spec.global, None);
        assert_eq!(
            spec.overrides,
            vec![
                ("ai".to_string(), Threshold::At(Level::Debug)),
                ("ogre".to_string(), Threshold::At(Level::Warn)),
            ]
        );
    }

    #[test]
    fn the_split_is_at_the_last_colon() {
        // `audio:real:debug` names the logger `audio:real`; a name is allowed to
        // contain a colon.
        let spec = parse_level_spec("audio:real:debug").expect("parses");
        assert_eq!(
            spec.overrides,
            vec![("audio:real".to_string(), Threshold::At(Level::Debug))]
        );
    }

    #[test]
    fn a_global_and_overrides_mix_in_one_spec() {
        let mut config = Config::default();
        config.set_level_spec("warn,ai:trace").expect("parses");
        assert_eq!(config.global, Threshold::At(Level::Warn));
        assert_eq!(
            config.overrides,
            vec![("ai".to_string(), Threshold::At(Level::Trace))]
        );
    }

    #[test]
    fn a_later_setting_for_the_same_name_replaces() {
        let mut config = Config::default();
        config.set_level_spec("ai:trace").expect("parses");
        config.set_level_spec("ai:error").expect("parses");
        assert_eq!(
            config.overrides,
            vec![("ai".to_string(), Threshold::At(Level::Error))]
        );
    }

    #[test]
    fn unknown_levels_are_refused_with_the_offending_value() {
        let error = parse_level_spec("verbose").expect_err("refused");
        assert_eq!(
            error,
            ConfigError::UnknownLevel {
                entry: "verbose".to_string(),
                value: "verbose".to_string(),
            }
        );
        assert!(error.to_string().contains("is not a level"));

        let named = parse_level_spec("ai:loud").expect_err("refused");
        assert!(matches!(named, ConfigError::UnknownLevel { .. }));
        assert!(named.to_string().contains("`loud`"));
    }

    #[test]
    fn empty_and_nameless_entries_are_refused() {
        assert!(matches!(
            parse_level_spec("").expect_err("refused"),
            ConfigError::EmptyEntry { .. }
        ));
        assert!(matches!(
            parse_level_spec("info,").expect_err("refused"),
            ConfigError::EmptyEntry { .. }
        ));
        assert!(matches!(
            parse_level_spec(":debug").expect_err("refused"),
            ConfigError::MissingName { .. }
        ));
    }

    #[test]
    fn format_is_refused_when_it_is_neither_text_nor_json() {
        let mut config = Config::default();
        assert!(config.set_format("json").is_ok());
        assert_eq!(config.format, Format::Json);
        let error = config.set_format("yaml").expect_err("refused");
        assert_eq!(
            error,
            ConfigError::UnknownFormat {
                value: "yaml".to_string()
            }
        );
    }

    #[test]
    fn a_log_file_sets_the_file_sink() {
        let mut config = Config::default();
        config.set_file(PathBuf::from("/tmp/tension.log"));
        assert_eq!(config.sink, SinkKind::File(PathBuf::from("/tmp/tension.log")));
    }
}
