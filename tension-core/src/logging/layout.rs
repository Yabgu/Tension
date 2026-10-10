//! Layouts: a record to one line of text, in one of two formats.
//!
//! The layout runs **once, in the host**, for every record regardless of which
//! language produced it. That is the whole point of putting the record in the
//! middle: a C adapter, the guest, and the Rust core all hand over a
//! `(level, name, message)` triple, and the bytes on stderr are identical.
//!
//! Text — one line, `<ts> <LEVEL> <logger>: <message>`:
//!
//! ```text
//! 2026-10-10T19:46:12.345Z INFO  ogre: renderer started
//! ```
//!
//! JSON — one object per line:
//!
//! ```json
//! {"ts":"2026-10-10T19:46:12.345Z","level":"INFO","logger":"ogre","msg":"renderer started"}
//! ```
//!
//! Both formats are stable output: the field order, the level tag's case, and
//! the timestamp shape are the contract, not incidental.

use super::record::Record;
use super::time;

/// Which layout to apply.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum Format {
    Text,
    Json,
}

impl Format {
    /// Parse `text` or `json`, case-insensitively.
    pub fn parse(text: &str) -> Option<Format> {
        match text.trim().to_ascii_lowercase().as_str() {
            "text" => Some(Format::Text),
            "json" => Some(Format::Json),
            _ => None,
        }
    }

    /// The CLI spelling.
    pub fn as_str(self) -> &'static str {
        match self {
            Format::Text => "text",
            Format::Json => "json",
        }
    }
}

/// Render one record to a single line, without a trailing newline.
pub fn render(format: Format, record: &Record) -> String {
    match format {
        Format::Text => render_text(record),
        Format::Json => render_json(record),
    }
}

fn render_text(record: &Record) -> String {
    let ts = time::format_rfc3339(record.time);
    // The level tag is padded to five columns so the logger name starts in the
    // same place on every line — `INFO ` beside `DEBUG`, not a ragged column.
    let level = record.level.as_str();
    let logger = &record.logger;
    match &record.structured {
        // A structured-only record has no message, so the payload takes the
        // message slot rather than leaving a bare `logger: ` before a separator.
        Some(payload) if record.message.is_empty() => format!("{ts} {level:<5} {logger}: {payload}"),
        Some(payload) => format!("{ts} {level:<5} {logger}: {} | {payload}", record.message),
        None => format!("{ts} {level:<5} {logger}: {}", record.message),
    }
}

fn render_json(record: &Record) -> String {
    let ts = time::format_rfc3339(record.time);
    let mut out = String::with_capacity(record.logger.len() + record.message.len() + 96);
    out.push_str("{\"ts\":");
    out.push_str(&json_string(&ts));
    out.push_str(",\"level\":");
    out.push_str(&json_string(record.level.as_str()));
    out.push_str(",\"logger\":");
    out.push_str(&json_string(&record.logger));
    out.push_str(",\"msg\":");
    out.push_str(&json_string(&record.message));
    if let Some(payload) = &record.structured {
        out.push_str(",\"data\":");
        out.push_str(&json_data(payload));
    }
    out.push('}');
    out
}

/// A structured payload, spliced or quoted.
///
/// A payload that trims to a JSON container (`{…}` or `[…]`) is spliced
/// verbatim, so `--log-format=json` composes a nested object a `jq` filter can
/// walk. Anything else — a bare word, a number, a malformed fragment — is quoted
/// as a string, because the one guarantee the JSON layout makes is that the line
/// `jq` receives is parseable.
fn json_data(payload: &str) -> String {
    let trimmed = payload.trim_start();
    if trimmed.starts_with('{') || trimmed.starts_with('[') {
        payload.to_string()
    } else {
        json_string(payload)
    }
}

/// A JSON string literal: quotes, backslashes, and every control character the
/// RFC requires escaping. Non-ASCII is emitted as the UTF-8 bytes it already is
/// (JSON strings are Unicode; jq decodes them).
pub(crate) fn json_string(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for ch in text.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, UNIX_EPOCH};

    fn instant() -> std::time::SystemTime {
        UNIX_EPOCH + Duration::from_millis(1_700_000_000_345)
    }

    fn record(level: super::super::level::Level, logger: &str, message: &str) -> Record {
        Record::new(instant(), level, logger, message)
    }

    #[test]
    fn text_layout_is_the_documented_shape() {
        let line = render(
            Format::Text,
            &record(super::super::level::Level::Info, "ogre", "renderer started"),
        );
        assert_eq!(line, "2023-11-14T22:13:20.345Z INFO  ogre: renderer started");
    }

    #[test]
    fn the_level_column_is_five_wide_on_every_line() {
        use super::super::level::Level;
        // TRACE/DEBUG/ERROR/FATAL are five letters; INFO/WARN pad to five. The
        // logger name must begin at the same column either way.
        for (level, tag) in [
            (Level::Trace, "TRACE"),
            (Level::Info, "INFO "),
            (Level::Warn, "WARN "),
            (Level::Debug, "DEBUG"),
        ] {
            let line = render(Format::Text, &record(level, "name", "m"));
            let expected = format!("2023-11-14T22:13:20.345Z {tag} name: m");
            assert_eq!(line, expected, "{level:?}");
        }
    }

    #[test]
    fn text_appends_a_structured_payload_after_a_bar() {
        let line = render(
            Format::Text,
            &record(super::super::level::Level::Warn, "ogre", "retry")
                .with_structured("{\"attempt\":2}"),
        );
        assert_eq!(
            line,
            "2023-11-14T22:13:20.345Z WARN  ogre: retry | {\"attempt\":2}"
        );
    }

    #[test]
    fn a_structured_only_record_puts_the_payload_in_the_message_slot() {
        // No message: the payload is the whole record, so there is no bare
        // `logger: ` before a separator.
        let line = render(
            Format::Text,
            &record(super::super::level::Level::Info, "ai", "").with_structured("{\"n\":1}"),
        );
        assert_eq!(line, "2023-11-14T22:13:20.345Z INFO  ai: {\"n\":1}");
    }

    #[test]
    fn json_layout_is_a_flat_object() {
        let line = render(
            Format::Json,
            &record(super::super::level::Level::Info, "ogre", "renderer started"),
        );
        assert_eq!(
            line,
            "{\"ts\":\"2023-11-14T22:13:20.345Z\",\"level\":\"INFO\",\
             \"logger\":\"ogre\",\"msg\":\"renderer started\"}"
        );
    }

    #[test]
    fn json_splices_a_structured_container() {
        let line = render(
            Format::Json,
            &record(super::super::level::Level::Fatal, "ai", "boom")
                .with_structured("{\"code\":7,\"where\":\"load\"}"),
        );
        assert_eq!(
            line,
            "{\"ts\":\"2023-11-14T22:13:20.345Z\",\"level\":\"FATAL\",\
             \"logger\":\"ai\",\"msg\":\"boom\",\"data\":{\"code\":7,\"where\":\"load\"}}"
        );
    }

    #[test]
    fn json_quotes_a_structured_non_container() {
        let line = render(
            Format::Json,
            &record(super::super::level::Level::Debug, "core", "count")
                .with_structured("42"),
        );
        assert!(line.ends_with(",\"data\":\"42\"}"), "{line}");
    }

    #[test]
    fn json_escapes_quotes_backslashes_and_controls() {
        let line = render(
            Format::Json,
            &record(
                super::super::level::Level::Error,
                "a\"b",
                "quote\" back\\slash\nnewline\ttab",
            ),
        );
        assert!(line.contains(r#""logger":"a\"b""#), "{line}");
        assert!(line.contains(r#"quote\" back\\slash\nnewline\ttab"#), "{line}");
        // No raw newline ever reaches the sink: one record is one line.
        assert!(!line.contains('\n'), "the record must be a single line: {line}");
    }

    #[test]
    fn json_escapes_a_control_character_as_u_escape() {
        let line = render(
            Format::Json,
            &record(super::super::level::Level::Info, "core", "bell\u{07}"),
        );
        assert!(line.contains("\\u0007"), "{line}");
    }

    #[test]
    fn format_parses_both_spellings() {
        assert_eq!(Format::parse("JSON"), Some(Format::Json));
        assert_eq!(Format::parse(" text "), Some(Format::Text));
        assert_eq!(Format::parse("yaml"), None);
        assert_eq!(Format::Json.as_str(), "json");
        assert_eq!(Format::Text.as_str(), "text");
    }
}
