//! Sinks: where a rendered line goes.
//!
//! The trait is one method wide on purpose. A sink owns no policy — it does not
//! filter, format, or timestamp — so a second one is small: the ring-buffer sink
//! an in-game debug overlay will want is a `Vec` behind a lock, and nothing else
//! here changes to add it.
//!
//! `write_line` takes `&mut self` rather than `&self`: the logger already holds
//! the sink behind its own lock, so the sink needs no interior mutability of its
//! own, and a file sink is then just a `File`. The cost is that a sink is not
//! shared by reference — which no caller wants.

use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::path::PathBuf;

/// One destination for rendered log lines.
pub trait Sink: Send {
    /// Write one already-rendered line. Newlines are the sink's business: it
    /// terminates the line.
    fn write_line(&mut self, line: &str);

    /// Push anything buffered to the destination. A no-op by default.
    fn flush(&mut self) {}
}

/// The default sink: `stderr`.
#[derive(Debug, Default)]
pub struct StderrSink;

impl Sink for StderrSink {
    fn write_line(&mut self, line: &str) {
        let stderr = io::stderr();
        let mut lock = stderr.lock();
        // A failed write to stderr is not worth a panic — there is nowhere left
        // to report it, and a logging call must never take the process down.
        let _ = writeln!(lock, "{line}");
    }

    fn flush(&mut self) {
        let _ = io::stderr().flush();
    }
}

/// A file sink, opened in append mode so a second run does not truncate the
/// first.
#[derive(Debug)]
pub struct FileSink {
    file: File,
}

impl Sink for FileSink {
    fn write_line(&mut self, line: &str) {
        let _ = writeln!(self.file, "{line}");
    }

    fn flush(&mut self) {
        let _ = self.file.flush();
    }
}

/// Discards every line. Useful for tests and for `--log-level=off` with a
/// configured file the caller still wants created.
#[derive(Debug, Default)]
pub struct NullSink;

impl Sink for NullSink {
    fn write_line(&mut self, _line: &str) {}
}

/// A sink that keeps its lines in memory. Tests read them back; it is not part
/// of the shipping surface (the ring-buffer overlay sink, when it lands, will be
/// its own type).
#[cfg(test)]
#[derive(Default)]
pub struct MemorySink {
    pub lines: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
}

#[cfg(test)]
impl Sink for MemorySink {
    fn write_line(&mut self, line: &str) {
        self.lines
            .lock()
            .expect("the test sink lock is never poisoned")
            .push(line.to_string());
    }
}

/// How the sink is chosen on the command line.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SinkKind {
    /// stderr — the default.
    Stderr,
    /// Append to this file.
    File(PathBuf),
    /// Discard.
    Null,
}

impl SinkKind {
    /// Open the sink. Only a file can fail.
    pub fn open(&self) -> Result<Box<dyn Sink>, SinkError> {
        match self {
            SinkKind::Stderr => Ok(Box::new(StderrSink)),
            SinkKind::Null => Ok(Box::new(NullSink)),
            SinkKind::File(path) => {
                let file = OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(path)
                    .map_err(|source| SinkError {
                        path: Some(path.clone()),
                        source,
                    })?;
                Ok(Box::new(FileSink { file }))
            }
        }
    }
}

/// Why a sink could not be opened.
#[derive(Debug)]
pub struct SinkError {
    /// The file that failed, when the sink was a file.
    pub path: Option<PathBuf>,
    pub source: io::Error,
}

impl std::fmt::Display for SinkError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match &self.path {
            Some(path) => write!(f, "could not open log file {}: {}", path.display(), self.source),
            None => write!(f, "could not open the log sink: {}", self.source),
        }
    }
}

impl std::error::Error for SinkError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.source)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stderr_and_null_sinks_open() {
        assert!(SinkKind::Stderr.open().is_ok());
        assert!(SinkKind::Null.open().is_ok());
    }

    #[test]
    fn a_null_sink_discards_lines() {
        let mut sink = SinkKind::Null.open().expect("null opens");
        sink.write_line("nothing to see");
        sink.flush();
    }

    #[test]
    fn a_file_sink_appends() {
        let path = std::env::temp_dir().join(format!(
            "tension-logger-sink-{}.log",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&path);

        {
            let mut sink = SinkKind::File(path.clone()).open().expect("file opens");
            sink.write_line("first");
        }
        {
            // A second open appends rather than truncates.
            let mut sink = SinkKind::File(path.clone()).open().expect("reopens");
            sink.write_line("second");
        }

        let contents = std::fs::read_to_string(&path).expect("read back");
        assert_eq!(contents, "first\nsecond\n");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_missing_directory_is_a_named_error() {
        let path = std::env::temp_dir()
            .join("tension-logger-no-such-dir")
            .join("x.log");
        let error = SinkKind::File(path.clone())
            .open()
            .err()
            .expect("a missing directory is refused");
        assert_eq!(error.path.as_deref(), Some(path.as_path()));
        assert!(error.to_string().contains("could not open log file"));
    }

    #[test]
    fn the_memory_sink_captures_lines() {
        let memory = MemorySink::default();
        let handle = std::sync::Arc::clone(&memory.lines);
        let mut sink: Box<dyn Sink> = Box::new(memory);
        sink.write_line("a");
        sink.write_line("b");
        assert_eq!(*handle.lock().expect("lock"), vec!["a", "b"]);
    }
}
