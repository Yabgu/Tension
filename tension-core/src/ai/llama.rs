//! Real `tension::ai` adapter: llama.cpp, in-process (`--features ai`).
//!
//! llama.cpp is linked as a library — no sidecar process, no HTTP, no Ollama.
//! The host stays low-level: the game names the model, writes the
//! conversation and reads the reply; this file only runs the machine.
//!
//! Two structural choices are load-bearing:
//!
//! * **A worker thread per session.** `session_create` blocks while the model
//!   loads, exactly as the ABI promises, but generation does not block the
//!   guest: the worker decodes tokens and appends UTF-8 to a shared buffer
//!   that `session_read` drains. `session_close` joins that thread, so a
//!   closed session leaves no thread running.
//! * **A context per generation.** `LlamaContext<'a>` borrows its
//!   `LlamaModel`, so keeping one alive across the session's life would need a
//!   self-referential struct, `unsafe`, or a leak. Building it per `generate`
//!   avoids all three and matches the semantics anyway: every generate
//!   re-decodes the whole history, so no KV state is meant to carry over.
//!
//! `model.blob` is **refused here**: the pinned `llama-cpp-2` exposes only
//! `LlamaModel::load_from_file`, so there is no in-process loader for
//! guest-supplied GGUF bytes. The ABI keeps the key (the SDK encodes it, the
//! stub accepts it), so a later crate version implements it without a guest
//! rebuild — the same reasoning as the deferred grammar keys.

use std::collections::HashMap;
use std::num::NonZeroU32;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, OnceLock};
use std::thread::{self, JoinHandle};

use llama_cpp_2::context::params::LlamaContextParams;
use llama_cpp_2::llama_backend::LlamaBackend;
use llama_cpp_2::llama_batch::LlamaBatch;
use llama_cpp_2::model::params::LlamaModelParams;
use llama_cpp_2::model::{AddBos, LlamaChatMessage, LlamaModel};
use llama_cpp_2::sampling::LlamaSampler;

use crate::ai::{log, AiAdapter, AiConfig};

/// Roles as the ABI numbers them.
const ROLE_SYSTEM: i32 = 0;
const ROLE_USER: i32 = 1;
const ROLE_ASSISTANT: i32 = 2;

/// Map an ABI role number onto llama.cpp's chat-template role name.
fn role_name(role: i32) -> Option<&'static str> {
    match role {
        ROLE_SYSTEM => Some("system"),
        ROLE_USER => Some("user"),
        ROLE_ASSISTANT => Some("assistant"),
        _ => None,
    }
}

/// llama.cpp's backend is process-global and `init` fails if called twice, so
/// it is initialized once and the *result* is cached (no panic on failure).
fn backend() -> Result<&'static LlamaBackend, String> {
    static BACKEND: OnceLock<Result<LlamaBackend, String>> = OnceLock::new();
    BACKEND
        .get_or_init(|| {
            LlamaBackend::init().map_err(|e| format!("llama backend init failed: {e}"))
        })
        .as_ref()
        .map_err(|e| e.clone())
}

/// State shared between the guest-facing thread and a session's worker.
#[derive(Default)]
struct Inner {
    /// The conversation as the game wrote it: `(role, text)` in append order.
    history: Vec<(i32, String)>,
    /// Decoded reply bytes; `pos` is how many of them the guest has consumed.
    reply: Vec<u8>,
    pos: usize,
    generating: bool,
    cancel: bool,
    shutdown: bool,
    /// Set by `generate`, cleared by the worker. One flag is enough because
    /// `generate` is refused while `generating` holds.
    run: bool,
}

struct Shared {
    inner: Mutex<Inner>,
    cv: Condvar,
}

/// Never hold this guard across a blocking wait or a `join`: the worker needs
/// it to publish each token.
fn lock(shared: &Shared) -> MutexGuard<'_, Inner> {
    shared.inner.lock().unwrap_or_else(|e| e.into_inner())
}

/// Append decoded text to the reply buffer. `false` means the guest cancelled
/// (or the session is closing), which is the worker's signal to stop.
fn push_text(shared: &Shared, piece: &str) -> bool {
    let mut inner = lock(shared);
    if inner.cancel || inner.shutdown {
        return false;
    }
    inner.reply.extend_from_slice(piece.as_bytes());
    shared.cv.notify_all();
    true
}

/// The session's worker thread: wait for a job, run it, wait again.
fn worker_loop(model: Arc<LlamaModel>, shared: Arc<Shared>, cfg: AiConfig) {
    loop {
        {
            let mut inner = lock(&shared);
            while !inner.run && !inner.shutdown {
                inner = shared.cv.wait(inner).unwrap_or_else(|e| e.into_inner());
            }
            if inner.shutdown {
                return;
            }
            inner.run = false;
        }
        run_completion(&model, &shared, &cfg);
    }
}

/// Run one completion and settle the bookkeeping. The reply text itself is
/// streamed piece by piece; this decides what the history keeps.
fn run_completion(model: &LlamaModel, shared: &Shared, cfg: &AiConfig) {
    let outcome = generate_text(model, shared, cfg);

    let mut inner = lock(shared);
    let assistant = match outcome {
        Ok(text) => Some(text),
        Err(message) => {
            // A failed generate must not be silent: the reason lands in the
            // reply buffer under a marker the game can look for. It is not
            // appended to the history, because the model never said it.
            log(&format!("generate failed: {message}"));
            let note = format!("[tension:ai] error: {message}");
            inner.reply.extend_from_slice(note.as_bytes());
            None
        }
    };
    if let Some(text) = assistant {
        // Cancelled generations keep the partial text, and it becomes the
        // assistant turn: it is exactly what the guest already read.
        if !text.is_empty() {
            inner.history.push((ROLE_ASSISTANT, text));
        }
    }
    inner.generating = false;
    inner.cancel = false;
    shared.cv.notify_all();
}

/// Chat-template the history when the model carries a template, else fall back
/// to a plain role-tagged transcript. A *named* template that does not resolve
/// is an error rather than a fallback: the game asked for something specific.
fn build_prompt(
    model: &LlamaModel,
    history: &[(i32, String)],
    cfg: &AiConfig,
) -> Result<String, String> {
    let messages: Vec<LlamaChatMessage> = history
        .iter()
        .filter_map(|(role, text)| {
            role_name(*role)
                .and_then(|name| LlamaChatMessage::new(name.to_string(), text.clone()).ok())
        })
        .collect();

    match model.chat_template(cfg.chat_template.as_deref()) {
        Ok(template) => model
            .apply_chat_template(&template, &messages, true)
            .map_err(|e| format!("chat template failed: {e}")),
        Err(e) => match cfg.chat_template.as_deref() {
            Some(name) => Err(format!("chat template '{name}' not found: {e}")),
            None => {
                log("model carries no chat template; using a plain role-tagged transcript");
                Ok(plain_prompt(history))
            }
        },
    }
}

/// Fallback rendering for models whose GGUF carries no chat template.
fn plain_prompt(history: &[(i32, String)]) -> String {
    let mut out = String::new();
    for (role, text) in history {
        out.push_str(role_name(*role).unwrap_or("user"));
        out.push_str(": ");
        out.push_str(text);
        out.push('\n');
    }
    out.push_str("assistant:");
    out
}

/// Context parameters for one generation, straight off the session config.
fn ctx_params(cfg: &AiConfig) -> LlamaContextParams {
    let mut params = LlamaContextParams::default()
        .with_n_ctx(NonZeroU32::new(cfg.ctx_size.max(1) as u32))
        .with_n_batch(cfg.batch.max(1) as u32);
    if cfg.threads > 0 {
        params = params
            .with_n_threads(cfg.threads as i32)
            .with_n_threads_batch(cfg.threads as i32);
    }
    params
}

/// The sampler chain. `temp <= 0` means greedy, which is also the one case
/// where `top_k` / `top_p` / `dist` would be noise.
fn build_sampler(cfg: &AiConfig) -> LlamaSampler {
    if cfg.temp <= 0.0 {
        return LlamaSampler::greedy();
    }
    LlamaSampler::chain_simple([
        LlamaSampler::temp(cfg.temp as f32),
        LlamaSampler::top_k(cfg.top_k as i32),
        LlamaSampler::top_p(cfg.top_p as f32, 1),
        LlamaSampler::dist(cfg.seed as u32),
    ])
}

/// Build the prompt, evaluate it, and sample until EOG, the token cap, the
/// context edge, or cancellation. Every decoded piece is streamed into the
/// reply buffer as it is produced, so `session_read` sees text mid-generation.
fn generate_text(model: &LlamaModel, shared: &Shared, cfg: &AiConfig) -> Result<String, String> {
    let history = lock(shared).history.clone();

    let n_ctx = cfg.ctx_size.max(1) as u32;
    let max_tokens = cfg.max_tokens.max(1) as usize;
    let n_batch = cfg.batch.max(1) as u32;

    let prompt = build_prompt(model, &history, cfg)?;
    let mut tokens = model
        .str_to_token(&prompt, AddBos::Always)
        .map_err(|e| format!("tokenize failed: {e}"))?;
    if tokens.is_empty() {
        return Err("the tokenizer produced an empty prompt".to_string());
    }

    // Hold back `max_tokens` of the window so the decode loop below can never
    // run the context out of room part-way through a reply.
    let budget = n_ctx.saturating_sub(max_tokens as u32).max(1) as usize;
    if tokens.len() > budget {
        let dropped = tokens.len() - budget;
        log(&format!(
            "prompt of {} tokens exceeds the {budget}-token budget; dropped the oldest {dropped}",
            tokens.len()
        ));
        tokens.drain(..dropped);
    }

    let mut ctx = model
        .new_context(backend()?, ctx_params(cfg))
        .map_err(|e| format!("cannot create context: {e}"))?;

    // Evaluate the prompt in `n_batch`-sized pieces; only the final token of
    // the prompt needs logits, because that is the one we sample from.
    let last = tokens.len() - 1;
    let mut batch = LlamaBatch::new(n_batch as usize, 1);
    for (i, token) in tokens.iter().enumerate() {
        let wants_logits = i == last;
        batch
            .add(*token, i as i32, &[0], wants_logits)
            .map_err(|e| format!("batch add failed: {e}"))?;
        if batch.n_tokens() as u32 >= n_batch || wants_logits {
            ctx.decode(&mut batch)
                .map_err(|e| format!("prompt decode failed: {e}"))?;
            batch.clear();
        }
    }

    let mut sampler = build_sampler(cfg);
    // One decoder for the whole generation: a token whose bytes end mid
    // codepoint emits nothing until the next token completes it, which is how
    // the guest is guaranteed whole UTF-8.
    let mut decoder = encoding_rs::UTF_8.new_decoder();
    let mut text = String::new();
    let mut pos = tokens.len() as i32;
    let mut produced = 0usize;

    while produced < max_tokens {
        // `sample` runs the chain and accepts the token itself; calling
        // `accept` afterwards would advance the sampler's state twice. `-1`
        // selects the last output row, which is the only one we asked for.
        let token = sampler.sample(&ctx, -1);
        if model.is_eog_token(token) {
            break;
        }

        let piece = model
            .token_to_piece(token, &mut decoder, false, None)
            .map_err(|e| format!("detokenize failed: {e}"))?;
        if !piece.is_empty() {
            text.push_str(&piece);
            if !push_text(shared, &piece) {
                break; // cancelled or closing: keep what was streamed
            }
        }
        produced += 1;

        if pos + 1 >= n_ctx as i32 {
            log("context window reached; ending the reply");
            break;
        }
        batch
            .add(token, pos, &[0], true)
            .map_err(|e| format!("batch add failed: {e}"))?;
        ctx.decode(&mut batch)
            .map_err(|e| format!("decode failed: {e}"))?;
        batch.clear();
        pos += 1;
    }

    Ok(text)
}

/// Load the model, turning a llama.cpp-side panic into an ordinary error so a
/// bad model file cannot take the interpreter down with it. (The crate's own
/// loader has a `debug_assert` on the path, so this is load-bearing in debug
/// builds, not just belt-and-braces.)
fn load_model(backend: &'static LlamaBackend, cfg: &AiConfig) -> Result<LlamaModel, String> {
    let params = LlamaModelParams::default().with_n_gpu_layers(cfg.gpu_layers.max(0) as u32);
    let path = cfg
        .model_path
        .clone()
        .ok_or_else(|| "no model.path in the config".to_string())?;

    match catch_unwind(AssertUnwindSafe(|| {
        LlamaModel::load_from_file(backend, path.as_str(), &params)
            .map_err(|e| format!("cannot load model '{path}': {e}"))
    })) {
        Ok(result) => result,
        Err(_) => Err(format!("loading model '{path}' panicked")),
    }
}

/// One live session: the state the worker shares with the guest, plus the
/// worker itself so `session_close` can join it.
struct Session {
    shared: Arc<Shared>,
    worker: Option<JoinHandle<()>>,
}

/// The llama.cpp adapter. Handles are opaque and monotonic; the session cap
/// belongs to the gate, not here.
pub struct LlamaAdapter {
    next_handle: i32,
    sessions: HashMap<i32, Session>,
}

impl LlamaAdapter {
    pub fn new() -> Self {
        Self {
            next_handle: 1,
            sessions: HashMap::new(),
        }
    }
}

impl Default for LlamaAdapter {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for LlamaAdapter {
    fn drop(&mut self) {
        // The gate already does this on game exit; a directly-held adapter
        // (tests, or a future non-gated caller) still must not leak threads.
        self.close_all();
    }
}

impl AiAdapter for LlamaAdapter {
    fn create(&mut self, cfg: &AiConfig, _blob: Option<&[u8]>) -> Result<i32, String> {
        if cfg.model_path.is_none() {
            return Err("model.blob is not supported by this build: the pinned llama-cpp-2 \
                        exposes only LlamaModel::load_from_file. Set model.path instead."
                .to_string());
        }

        let backend = backend()?;
        // Say so *before* the wait: this call blocks for as long as it takes to
        // map the weights, and a silent multi-second pause reads as a hang.
        log(&format!("loading model ({}) ...", cfg.model_desc()));
        let started = std::time::Instant::now();
        let model = load_model(backend, cfg)?; // blocking, as the ABI promises
        log(&format!(
            "model loaded in {:.2}s",
            started.elapsed().as_secs_f64()
        ));

        let handle = self.next_handle;
        self.next_handle += 1;

        let shared = Arc::new(Shared {
            inner: Mutex::new(Inner::default()),
            cv: Condvar::new(),
        });
        let worker = {
            let shared = Arc::clone(&shared);
            let model = Arc::new(model);
            let cfg = cfg.clone();
            thread::Builder::new()
                .name(format!("tension-ai-{handle}"))
                .spawn(move || worker_loop(model, shared, cfg))
                .map_err(|e| format!("cannot spawn the session worker: {e}"))?
        };

        self.sessions.insert(
            handle,
            Session {
                shared,
                worker: Some(worker),
            },
        );
        log(&format!(
            "session {handle} ready ({}; ctx={})",
            cfg.model_desc(),
            cfg.ctx_size
        ));
        Ok(handle)
    }

    fn add(&mut self, session: i32, role: i32, text: &str) -> i32 {
        let Some(session) = self.sessions.get(&session) else {
            return -1;
        };
        if role_name(role).is_none() {
            return -1;
        }
        let mut inner = lock(&session.shared);
        if inner.generating {
            return -1;
        }
        inner.history.push((role, text.to_string()));
        0
    }

    fn generate(&mut self, session: i32) -> i32 {
        let Some(session) = self.sessions.get(&session) else {
            return -1;
        };
        let mut inner = lock(&session.shared);
        // A previous reply still unread would be destroyed by the reset below,
        // so refuse instead: the guest drains (or resets) and asks again.
        if inner.generating || inner.reply.len() > inner.pos {
            return -1;
        }
        inner.reply.clear();
        inner.pos = 0;
        inner.cancel = false;
        inner.generating = true;
        inner.run = true;
        session.shared.cv.notify_all();
        0
    }

    fn state(&mut self, session: i32) -> i32 {
        match self.sessions.get(&session) {
            None => -1,
            Some(session) => i32::from(lock(&session.shared).generating),
        }
    }

    fn read_pending(&mut self, session: i32) -> Option<usize> {
        self.sessions.get(&session).map(|session| {
            let inner = lock(&session.shared);
            inner.reply.len() - inner.pos
        })
    }

    fn read_consume(&mut self, session: i32, cap: i32) -> Option<Vec<u8>> {
        let session = self.sessions.get(&session)?;
        let mut inner = lock(&session.shared);
        let unread = inner.reply.len() - inner.pos;
        let take = unread.min(cap.max(0) as usize);
        let bytes = inner.reply[inner.pos..inner.pos + take].to_vec();
        inner.pos += take;
        Some(bytes)
    }

    fn cancel(&mut self, session: i32) -> i32 {
        let Some(session) = self.sessions.get(&session) else {
            return -1;
        };
        let mut inner = lock(&session.shared);
        if !inner.generating {
            return -1;
        }
        inner.cancel = true;
        session.shared.cv.notify_all();
        0
    }

    fn reset(&mut self, session: i32) -> i32 {
        let Some(session) = self.sessions.get(&session) else {
            return -1;
        };
        let mut inner = lock(&session.shared);
        if inner.generating {
            return -1;
        }
        inner.history.clear();
        inner.reply.clear();
        inner.pos = 0;
        0
    }

    fn close(&mut self, session: i32) -> i32 {
        let Some(mut session) = self.sessions.remove(&session) else {
            return -1;
        };
        {
            let mut inner = lock(&session.shared);
            inner.shutdown = true;
            inner.cancel = true;
            session.shared.cv.notify_all();
        }
        // Join with the lock released: the worker needs the guard to see the
        // shutdown flag and return, and a worker mid-decode must be waited out
        // rather than abandoned.
        if let Some(worker) = session.worker.take() {
            let _ = worker.join();
        }
        0
    }

    fn close_all(&mut self) {
        let handles: Vec<i32> = self.sessions.keys().copied().collect();
        for handle in handles {
            self.close(handle);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::BlobRef;

    fn missing_model_cfg() -> AiConfig {
        AiConfig {
            model_path: Some("definitely-not-a-real-model.gguf".to_string()),
            ..AiConfig::default()
        }
    }

    /// The pinned crate has no in-memory loader, so a blob-only config must be
    /// refused with a message that says why — not accepted and then failed
    /// deep inside llama.cpp.
    #[test]
    fn create_refuses_a_blob_only_config() {
        let mut adapter = LlamaAdapter::new();
        let cfg = AiConfig {
            model_blob: Some(BlobRef { len: 4, ptr: 0 }),
            ..AiConfig::default()
        };
        let err = adapter.create(&cfg, Some(&[0u8; 4])).unwrap_err();
        assert!(err.contains("model.blob"), "{err}");
    }

    /// A bad model path is an error, never a panic: llama.cpp asserts inside
    /// its own loader, and `load_model` is the boundary that contains it.
    #[test]
    fn create_reports_a_missing_model_without_panicking() {
        let mut adapter = LlamaAdapter::new();
        let err = adapter.create(&missing_model_cfg(), None).unwrap_err();
        assert!(err.contains("definitely-not-a-real-model.gguf"), "{err}");
    }

    /// Every verb answers for an unknown handle instead of inventing state.
    #[test]
    fn unknown_handles_are_rejected() {
        let mut adapter = LlamaAdapter::new();
        assert_eq!(adapter.state(7), -1);
        assert_eq!(adapter.add(7, 1, "hi"), -1);
        assert_eq!(adapter.generate(7), -1);
        assert_eq!(adapter.cancel(7), -1);
        assert_eq!(adapter.reset(7), -1);
        assert_eq!(adapter.close(7), -1);
        assert_eq!(adapter.read_pending(7), None);
        assert_eq!(adapter.read_consume(7, 4), None);
        adapter.close_all();
    }
}
