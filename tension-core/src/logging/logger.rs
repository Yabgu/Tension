//! The logger core and its process-global instance.
//!
//! # Thread safety
//!
//! One `OnceLock<Mutex<LoggerCore>>` holds the whole thing. The mutex is what
//! makes the logger safe to call from any thread — native adapters log from
//! render threads, and `post_event`'s any-thread rule means the adapter host
//! already expects that — and it is *one* lock, taken for the length of one
//! `emit`, which also serialises the sink so two threads' lines never interleave
//! mid-write.
//!
//! The alternative was an `mpsc` queue drained by a background thread, which
//! buys non-blocking producers. It was rejected: a drain thread adds ordering
//! questions (the queue drains on someone else's schedule), a shutdown handshake
//! the host has no place for, and a second clock — and the writers here are a
//! handful of adapter threads, not a hot loop. The mutex is the honest cost.
//!
//! A poisoned lock (a panic during a previous `emit`) is recovered with
//! `into_inner()` rather than propagated: logging must not be the thing that
//! takes the process down, and the C ABI entry points swallow panics for the
//! same reason.
//!
//! # The not-initialised path
//!
//! `main` installs the logger before the guest, the session, or any adapter is
//! touched. A process that never calls [`init`] — a C harness that links the
//! `tension_log` symbol directly, a unit test — still gets its lines: [`emit`]
//! falls back to a text-layout line on stderr, gated at `info`. That keeps the
//! C ABI useful without a host, and keeps the fallback from being a second
//! layout implementation (it renders through the same `layout` module).

use std::io::Write;
use std::sync::{Mutex, OnceLock};

use super::config::Config;
use super::filter::Filter;
use super::layout::{self, Format};
use super::level::Level;
use super::record::Record;
use super::sink::{Sink, SinkError};
use super::time::{Clock, SystemClock};

/// The logger: a filter, a layout, a sink, and a clock.
///
/// Public so tests can build one with an injected clock and an in-memory sink;
/// production code reaches it only through the process-global functions below.
pub struct LoggerCore {
    filter: Filter,
    format: Format,
    sink: Box<dyn Sink>,
    clock: Box<dyn Clock>,
}

impl LoggerCore {
    /// Build a logger from a config, opening the sink.
    pub fn new(config: &Config) -> Result<LoggerCore, SinkError> {
        Ok(LoggerCore {
            filter: Filter::from_config(config),
            format: config.format,
            sink: config.sink.open()?,
            clock: Box::new(SystemClock),
        })
    }

    /// Whether this logger would emit `level` from `logger`.
    pub fn allows(&self, logger: &str, level: Level) -> bool {
        self.filter.allows(logger, level)
    }

    /// Render and write one record. Returns whether it passed the filter.
    ///
    /// The filter is consulted *before* the record is built, so a dropped line
    /// costs one comparison and no allocation.
    pub fn emit(
        &mut self,
        level: Level,
        logger: &str,
        message: &str,
        structured: Option<&str>,
    ) -> bool {
        if !self.filter.allows(logger, level) {
            return false;
        }
        let record = Record {
            time: self.clock.now(),
            level,
            logger: logger.to_string(),
            message: message.to_string(),
            structured: structured.map(str::to_owned),
        };
        self.sink.write_line(&layout::render(self.format, &record));
        true
    }

    /// Flush the sink.
    pub fn flush(&mut self) {
        self.sink.flush();
    }

    /// A logger with an injected clock and sink, for deterministic tests.
    #[cfg(test)]
    pub(crate) fn for_test(config: &Config, sink: Box<dyn Sink>, clock: Box<dyn Clock>) -> LoggerCore {
        LoggerCore {
            filter: Filter::from_config(config),
            format: config.format,
            sink,
            clock,
        }
    }
}

/// The process-global logger.
static LOGGER: OnceLock<Mutex<LoggerCore>> = OnceLock::new();

/// Install the logger. Called once, from `main`, before the guest and any
/// adapter exist.
///
/// A second call is a no-op that returns `Ok`: the process has one logger, and
/// re-configuring it mid-run is a feature this chunk does not have. The sink is
/// still opened first, so a bad `--log-file` is reported even on a second call.
pub fn init(config: Config) -> Result<(), SinkError> {
    let core = LoggerCore::new(&config)?;
    match LOGGER.set(Mutex::new(core)) {
        Ok(()) => Ok(()),
        Err(_) => Ok(()), // already installed; the new core drops
    }
}

/// Whether [`init`] has run.
pub fn is_initialized() -> bool {
    LOGGER.get().is_some()
}

/// Whether a `(logger, level)` pair would be emitted. Uses the global threshold
/// (`info`) before [`init`], matching the fallback emitter's gate.
pub fn enabled(logger: &str, level: Level) -> bool {
    match LOGGER.get() {
        Some(mutex) => lock(mutex).allows(logger, level),
        None => level >= Level::Info,
    }
}

/// Emit one record through the installed logger, or the fallback.
pub fn emit(level: Level, logger: &str, message: &str, structured: Option<&str>) {
    match LOGGER.get() {
        Some(mutex) => {
            lock(mutex).emit(level, logger, message, structured);
        }
        None => fallback_emit(level, logger, message, structured),
    }
}

/// Emit a message with no structured payload.
pub fn log(level: Level, logger: &str, message: &str) {
    emit(level, logger, message, None);
}

/// Flush the installed logger's sink, if there is one.
pub fn flush() {
    if let Some(mutex) = LOGGER.get() {
        lock(mutex).flush();
    }
}

/// Take the lock, recovering rather than propagating a poisoning. A panic while
/// logging must not silence every later line.
fn lock(mutex: &Mutex<LoggerCore>) -> std::sync::MutexGuard<'_, LoggerCore> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The line a process that never called [`init`] gets: text layout, stderr,
/// gated at `info`.
fn fallback_emit(level: Level, logger: &str, message: &str, structured: Option<&str>) {
    if level < Level::Info {
        return;
    }
    let record = Record {
        time: SystemClock.now(),
        level,
        logger: logger.to_string(),
        message: message.to_string(),
        structured: structured.map(str::to_owned),
    };
    let line = layout::render(Format::Text, &record);
    let stderr = std::io::stderr();
    let _ = writeln!(stderr.lock(), "{line}");
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::logging::sink::MemorySink;
    use crate::logging::time::FixedClock;
    use std::sync::{Arc, Mutex as StdMutex};
    use std::time::{Duration, UNIX_EPOCH};

    fn instant() -> std::time::SystemTime {
        UNIX_EPOCH + Duration::from_millis(1_700_000_000_345)
    }

    /// A core wired to capture lines and hold the clock still.
    fn capturing(config: &Config) -> (LoggerCore, Arc<StdMutex<Vec<String>>>) {
        let memory = MemorySink::default();
        let lines = Arc::clone(&memory.lines);
        let core = LoggerCore::for_test(config, Box::new(memory), Box::new(FixedClock(instant())));
        (core, lines)
    }

    #[test]
    fn emit_renders_and_writes_a_passing_record() {
        let config = Config::default();
        let (mut core, lines) = capturing(&config);
        assert!(core.emit(Level::Info, "ogre", "renderer started", None));
        assert_eq!(
            *lines.lock().expect("lock"),
            vec!["2023-11-14T22:13:20.345Z INFO  ogre: renderer started"]
        );
    }

    #[test]
    fn a_record_below_the_threshold_is_dropped_without_writing() {
        let config = Config::default(); // global Info
        let (mut core, lines) = capturing(&config);
        assert!(!core.emit(Level::Debug, "ogre", "quiet", None));
        assert!(lines.lock().expect("lock").is_empty());
    }

    #[test]
    fn a_per_name_override_can_open_a_quiet_subsystem() {
        let mut config = Config::default();
        config.set_level_spec("ogre:debug").expect("parses");
        let (mut core, lines) = capturing(&config);
        assert!(core.emit(Level::Debug, "ogre", "verbose", None));
        assert!(!core.emit(Level::Debug, "ai", "still quiet", None));
        assert_eq!(lines.lock().expect("lock").len(), 1);
    }

    #[test]
    fn a_structured_payload_reaches_the_layout() {
        let mut config = Config::default();
        config.set_format("json").expect("parses");
        let (mut core, lines) = capturing(&config);
        assert!(core.emit(Level::Warn, "ogre", "retry", Some("{\"n\":2}")));
        assert_eq!(
            *lines.lock().expect("lock"),
            vec![
                "{\"ts\":\"2023-11-14T22:13:20.345Z\",\"level\":\"WARN\",\"logger\":\"ogre\",\
                 \"msg\":\"retry\",\"data\":{\"n\":2}}"
            ]
        );
    }

    #[test]
    fn init_opens_the_sink_and_reports_a_bad_file() {
        // A fresh process has no logger yet, but tests share one process and
        // other tests may have initialised it. What is testable without touching
        // the global: the sink-open error path.
        let config = Config {
            sink: crate::logging::sink::SinkKind::File(
                std::env::temp_dir().join("tension-logger-missing-dir").join("x.log"),
            ),
            ..Config::default()
        };
        let error = LoggerCore::new(&config)
            .err()
            .expect("a missing directory is refused");
        assert!(error.to_string().contains("could not open log file"));
    }

    #[test]
    fn a_null_sink_swallows_the_line_but_still_filters() {
        let config = Config {
            sink: crate::logging::sink::SinkKind::Null,
            ..Config::default()
        };
        let mut core = LoggerCore::new(&config).expect("opens");
        assert!(core.emit(Level::Error, "core", "gone", None));
        assert!(!core.emit(Level::Trace, "core", "also gone", None));
        core.flush();
    }
}
