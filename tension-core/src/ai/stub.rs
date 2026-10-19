//! Headless AI adapter.
//!
//! Implements the full `tension::ai` contract with no model and zero AI
//! dependencies: `session_generate` produces a short **deterministic** reply
//! (prefixed `[ai-stub] `), so the SDK, the examples and the tests can run
//! with no GGUF file and no C++ build. It is the no-feature fallback and the
//! test adapter, mirroring `audio/headless.rs`.
//!
//! It is still a real implementation of the semantics, not a mock that
//! returns canned codes: history is stored, the reply is context-derived,
//! the assistant turn is appended on completion, and unread reply bytes must
//! be drained before the next `session_generate` — exactly the state machine
//! the llama adapter implements.

use std::collections::HashMap;

use crate::ai::{AiAdapter, AiConfig, AiSink, StreamGate, StreamPost};

/// Roles accepted by `session_add` (0 = system, 1 = user, 2 = assistant).
const ROLE_SYSTEM: i32 = 0;
const ROLE_USER: i32 = 1;
const ROLE_ASSISTANT: i32 = 2;

struct StubSession {
    /// `(role, text)` in append order.
    history: Vec<(i32, String)>,
    /// The last generated reply, as UTF-8 bytes (`String` guarantees whole
    /// codepoints — the stub cannot emit a partial one).
    reply: Vec<u8>,
    /// How many reply bytes have been consumed by `read`.
    pos: usize,
    generating: bool,
    /// The same coalescing rule the real adapter runs: one outstanding READY,
    /// terminal deferred until the reply is drained. The stub streams so the
    /// await path is exercisable with no model and no GGUF — which is what makes
    /// the SDK's stream testable in a container without llama.cpp.
    gate: StreamGate,
}

impl StubSession {
    fn unread(&self) -> usize {
        self.reply.len() - self.pos
    }
}

pub struct StubAdapter {
    /// Handles start at 1 so 0 stays reserved for "create failed".
    next: i32,
    sessions: HashMap<i32, StubSession>,
    sink: AiSink,
    /// Test-only: make every generation fail. Set `TENSION_AI_STUB_FAIL=1`.
    ///
    /// The **error path** (the gate's `settled(failed)`, the `AI_ERROR` post,
    /// the guest's class-derived negative return) is otherwise unreachable with
    /// no model, and a control that cannot reach the path measures nothing. The
    /// injection is at the adapter — where a real failure originates — so the
    /// transport, the epoch, the dispatcher and the wrapper are the production
    /// ones; only the cause is synthetic.
    fail_generation: bool,
}

impl StubAdapter {
    pub fn new(sink: AiSink) -> Self {
        Self {
            next: 1,
            sessions: HashMap::new(),
            sink,
            fail_generation: matches!(
                std::env::var("TENSION_AI_STUB_FAIL").as_deref(),
                Ok("1") | Ok("true") | Ok("yes")
            ),
        }
    }

    /// Post whatever the gate asked for.
    fn post(&self, session: i32, post: Option<StreamPost>) {
        if let Some(post) = post {
            self.sink.post(post.class(), session, post.payload());
        }
    }
}

impl AiAdapter for StubAdapter {
    fn create(&mut self, cfg: &AiConfig, _blob: Option<&[u8]>) -> Result<i32, String> {
        // The gate validates the dict too; this keeps the adapter honest on
        // its own (the contract says no model key -> 0).
        if cfg.model_path.is_none() && cfg.model_blob.is_none() {
            return Err("no model key (need model.path or model.blob)".into());
        }
        let handle = self.next;
        self.next += 1;
        self.sessions.insert(
            handle,
            StubSession {
                history: Vec::new(),
                reply: Vec::new(),
                pos: 0,
                generating: false,
                gate: StreamGate::default(),
            },
        );
        Ok(handle)
    }

    fn add(&mut self, session: i32, role: i32, text: &str) -> i32 {
        let Some(s) = self.sessions.get_mut(&session) else {
            return -1;
        };
        if s.generating || !matches!(role, ROLE_SYSTEM | ROLE_USER | ROLE_ASSISTANT) {
            return -1;
        }
        s.history.push((role, text.to_string()));
        0
    }

    fn generate(&mut self, session: i32) -> i32 {
        // The posts are collected while the session is borrowed and made after
        // the borrow ends: `post` takes `&self`, and the session came from a
        // `&mut` of the same struct.
        let (posts, refusal) = {
            let Some(s) = self.sessions.get_mut(&session) else {
                return -1;
            };
            if s.generating || s.unread() > 0 {
                return -1;
            }
            let last_user = s
                .history
                .iter()
                .rev()
                .find(|(role, _)| *role == ROLE_USER)
                .map(|(_, text)| text.clone())
                .unwrap_or_default();
            let text = format!(
                "[ai-stub] {} message(s) in history; you said: {last_user}",
                s.history.len()
            );

            let mut posts: Vec<Option<StreamPost>> = Vec::new();
            s.reply.clear();
            s.pos = 0;
            s.generating = true;
            s.gate.begin();

            if self.fail_generation {
                // The real adapter's failure shape: the reason lands in the
                // reply buffer (the AI backend has no errno vocabulary), and the
                // completion carries AI_ERROR.
                let note = "[tension:ai] error: injected failure (TENSION_AI_STUB_FAIL)";
                s.reply.extend_from_slice(note.as_bytes());
                s.generating = false;
                let unread = s.reply.len() - s.pos;
                posts.push(s.gate.settled(true, unread));
                (posts, false)
            } else {
                // Append in pieces so a coalesced burst is real rather than
                // asserted: the first append posts READY with the running
                // count, the rest are swallowed until the guest drains.
                for piece in split_pieces(&text, 4) {
                    s.reply.extend_from_slice(piece.as_bytes());
                    let unread = s.reply.len() - s.pos;
                    posts.push(s.gate.appended(unread));
                }
                // Completion appends the assistant turn, exactly as a real
                // model does, and settles the stream.
                s.history.push((ROLE_ASSISTANT, text));
                s.generating = false;
                let unread = s.reply.len() - s.pos;
                posts.push(s.gate.settled(false, unread));
                (posts, false)
            }
        };
        if refusal {
            return -1;
        }
        for post in posts {
            self.post(session, post);
        }
        0
    }

    fn state(&mut self, session: i32) -> i32 {
        match self.sessions.get(&session) {
            None => -1,
            // The stub completes inside `generate`, so it is never observed
            // generating — but the state machine is real.
            Some(s) => i32::from(s.generating),
        }
    }

    fn read_pending(&mut self, session: i32) -> Option<usize> {
        self.sessions.get(&session).map(StubSession::unread)
    }

    fn read_consume(&mut self, session: i32, cap: i32) -> Option<Vec<u8>> {
        let (out, post) = {
            let s = self.sessions.get_mut(&session)?;
            let n = s.unread().min(cap.max(0) as usize);
            let out = s.reply[s.pos..s.pos + n].to_vec();
            s.pos += n;
            // The drain re-arms the stream and releases a deferred terminal.
            (out, s.gate.drained(s.unread()))
        };
        self.post(session, post);
        Some(out)
    }

    fn cancel(&mut self, session: i32) -> i32 {
        match self.sessions.get_mut(&session) {
            None => -1,
            // Nothing is ever in flight: cancellation has no target.
            Some(s) if !s.generating => -1,
            Some(s) => {
                s.generating = false;
                0
            }
        }
    }

    fn reset(&mut self, session: i32) -> i32 {
        match self.sessions.get_mut(&session) {
            None => -1,
            Some(s) if s.generating => -1,
            Some(s) => {
                s.history.clear();
                s.reply.clear();
                s.pos = 0;
                s.gate.begin();
                0
            }
        }
    }

    fn close(&mut self, session: i32) -> i32 {
        match self.sessions.remove(&session) {
            Some(_) => 0,
            None => -1,
        }
    }

    fn close_all(&mut self) {
        self.sessions.clear();
    }
}

/// Split `text` into at most `count` pieces, never inside a codepoint: a guest
/// decodes each read as a whole string, so a split byte would be a malformed
/// UTF-8 sequence at the ABI.
fn split_pieces(text: &str, count: usize) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    if count <= 1 || chars.is_empty() {
        return vec![text.to_string()];
    }
    let per = (chars.len() + count - 1) / count;
    chars
        .chunks(per.max(1))
        .map(|chunk| chunk.iter().collect())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::{AiConfig, AiSession, Value};

    fn cfg() -> AiConfig {
        let entries = vec![("model.path".to_string(), Value::Str(b"/m.gguf".to_vec()))];
        AiConfig::from_argmap(&entries).expect("valid config")
    }

    fn session() -> AiSession {
        AiSession::new(Box::new(StubAdapter::new(AiSink::detached())))
    }

    /// Drain a session the way a guest would: probe, then consume in chunks.
    fn drain(s: &mut AiSession, handle: i32) -> String {
        let mut out = Vec::new();
        loop {
            let n = s.read_probe(handle);
            assert!(n >= 0, "probe on a live handle must not fail");
            if n == 0 {
                break;
            }
            let chunk = s
                .read_consume(handle, 4)
                .expect("probe promised bytes, consume must deliver");
            assert!(!chunk.is_empty());
            out.extend_from_slice(&chunk);
        }
        String::from_utf8(out).expect("adapter only emits whole UTF-8 codepoints")
    }

    #[test]
    fn session_lifecycle_over_the_gate() {
        let mut s = session();
        let h = s.create(&cfg(), None);
        assert!(h > 0, "create must return a live handle");

        assert_eq!(s.state(h), 0);
        assert_eq!(s.add(h, 0, "you are a helpful narrator"), 0);
        assert_eq!(s.add(h, 1, ""), 0, "an empty message is allowed");
        assert_eq!(s.add(h, 1, "hello"), 0);
        assert_eq!(s.add(h, 7, "bad role"), -1);
        assert_eq!(s.add(999, 1, "unknown handle"), -1);

        assert_eq!(s.generate(h), 0);
        assert_eq!(s.state(h), 0, "the stub completes inside generate");

        // Probe is idempotent and non-consuming.
        let n = s.read_probe(h);
        assert!(n > 0);
        assert_eq!(s.read_probe(h), n);

        // Undrained reply bytes block the next generate.
        assert_eq!(s.generate(h), -1);

        let reply = drain(&mut s, h);
        assert!(reply.starts_with("[ai-stub] "), "reply text was {reply:?}");
        assert!(reply.contains("you said: hello"));

        // Drained: the next turn is allowed and sees the assistant turn too.
        assert_eq!(s.read_probe(h), 0);
        assert_eq!(s.generate(h), 0);
        let reply2 = drain(&mut s, h);
        assert!(reply2.contains("4 message(s)"), "reply text was {reply2:?}");

        assert_eq!(s.reset(h), 0);
        assert_eq!(s.read_probe(h), 0);
        assert_eq!(s.generate(h), 0);
        let reply3 = drain(&mut s, h);
        assert!(reply3.contains("0 message(s)"), "reply text was {reply3:?}");

        assert_eq!(s.cancel(h), -1, "nothing is in flight");
        assert_eq!(s.close(h), 0);
        assert_eq!(s.close(h), -1, "close is not idempotent at the verb level");
        assert_eq!(s.state(h), -1);
    }

    #[test]
    fn two_sessions_are_independent_and_close_cleanly() {
        let mut s = session();
        let a = s.create(&cfg(), None);
        let b = s.create(&cfg(), None);
        assert!(a > 0 && b > 0 && a != b);

        assert_eq!(s.add(a, 1, "alpha"), 0);
        assert_eq!(s.add(b, 1, "beta"), 0);
        assert_eq!(s.generate(a), 0);
        assert_eq!(s.generate(b), 0);

        let ra = drain(&mut s, a);
        let rb = drain(&mut s, b);
        assert!(ra.contains("alpha") && !ra.contains("beta"), "a got {ra:?}");
        assert!(rb.contains("beta") && !rb.contains("alpha"), "b got {rb:?}");

        assert_eq!(s.close(a), 0);
        assert!(s.read_probe(b) == 0, "closing one session leaves the other alive");
        assert_eq!(s.state(b), 0);
        assert_eq!(s.close(b), 0);
        assert_eq!(s.state(b), -1);
        assert!(s.live_handles().is_empty(), "every handle released");
    }

    #[test]
    fn gate_enforces_the_session_cap_and_recycles_handles() {
        let mut s = session();
        let handles: Vec<i32> = (0..crate::ai::MAX_SESSIONS).map(|_| s.create(&cfg(), None)).collect();
        assert!(handles.iter().all(|&h| h > 0), "the cap itself must succeed");
        assert_eq!(s.create(&cfg(), None), 0, "one past the cap fails");
        assert_eq!(s.live_handles().len(), crate::ai::MAX_SESSIONS);

        assert_eq!(s.close(handles[0]), 0);
        let fresh = s.create(&cfg(), None);
        assert!(fresh > 0, "a freed slot is reusable");
        assert!(!handles.contains(&fresh), "handles are never recycled");
    }

    #[test]
    fn create_rejects_a_config_with_no_model_key() {
        let entries = vec![("context.size".to_string(), Value::I64(512))];
        // The config layer already refuses this, so the adapter never sees it;
        // assert both layers hold the line.
        assert!(AiConfig::from_argmap(&entries).is_err());

        let mut s = session();
        let bad = AiConfig { model_path: None, model_blob: None, ..Default::default() };
        assert_eq!(s.create(&bad, None), 0);
    }
}
