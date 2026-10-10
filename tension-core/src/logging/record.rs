//! The record: one log event, before any layout has touched it.
//!
//! A record is deliberately language-neutral. The host builds one whether the
//! event came from Rust, from an adapter through the C ABI, or from the guest
//! through `tension::io::log`; the layout is applied once, in the host, which is
//! what makes two languages produce byte-identical lines for the same record.

use std::time::SystemTime;

use super::level::Level;

/// One log event.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Record {
    /// When the event was created, from the logger's clock.
    pub time: SystemTime,
    pub level: Level,
    /// The logger name, e.g. `ogre` or `audio:real`. Never empty in practice;
    /// an unnamed event uses the `core` name.
    pub logger: String,
    /// The human-readable message body.
    pub message: String,
    /// A structured payload, when the record came from a `*_structured` entry
    /// point. Raw text: the layout decides whether to splice it as JSON.
    pub structured: Option<String>,
}

impl Record {
    pub fn new(
        time: SystemTime,
        level: Level,
        logger: impl Into<String>,
        message: impl Into<String>,
    ) -> Record {
        Record {
            time,
            level,
            logger: logger.into(),
            message: message.into(),
            structured: None,
        }
    }

    /// Attach a structured payload (builder form).
    pub fn with_structured(mut self, payload: impl Into<String>) -> Record {
        self.structured = Some(payload.into());
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::UNIX_EPOCH;

    #[test]
    fn new_leaves_the_payload_absent() {
        let record = Record::new(UNIX_EPOCH, Level::Info, "core", "hello");
        assert_eq!(record.logger, "core");
        assert_eq!(record.message, "hello");
        assert_eq!(record.structured, None);
    }

    #[test]
    fn with_structured_attaches_the_payload() {
        let record =
            Record::new(UNIX_EPOCH, Level::Warn, "ogre", "warned").with_structured("{\"a\":1}");
        assert_eq!(record.structured.as_deref(), Some("{\"a\":1}"));
    }
}
