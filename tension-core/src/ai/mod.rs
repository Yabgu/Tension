//! `tension::ai` — the third Tension host service.
//!
//! `tension::io` is the first service (synchronous, stateless, terminal);
//! `tension::audio` is the second (stateful, driver thread); `tension::ai` is
//! the third: a **chat session** engine. The guest opens a session, feeds it
//! messages, asks for a completion, and streams the reply back out — the model
//! works on its own thread while the guest keeps running.
//!
//! # Low level by design
//!
//! The host is a text engine, not a game designer: no model registry, no
//! prompt policy, no agent loop, no auto-selection, no CLI flags for the
//! model. The game names the model and writes the conversation. llama.cpp is
//! linked **in-process** as a library (never a sidecar, HTTP endpoint, or
//! Ollama); this module is the boundary through which guest bytes reach it.
//!
//! # Contract
//!
//! Module name `tension::ai` (a core-wasm import module name, like
//! `tension::io`). Pointers are guest linear-memory offsets; strings are UTF-8
//! bytes with explicit ptr+len; `-1` is error/unknown. Host events and
//! failures log one line to stderr prefixed `[tension:ai]`; the hot poll verbs
//! (`session_state`, `session_read`) are only traced when `TENSION_AI_TRACE` is
//! set, so a guest's drain loop cannot bury those lines.
//!
//!   session_create(cfg_ptr, cfg_len) -> i32
//!       `> 0` session handle; `0` on failure (bad/empty dict, no model key,
//!       model load error, session limit reached). Blocking (model load).
//!       `cfg_len <= 0` is invalid -> `0`.
//!   session_add(session, role, ptr, len) -> i32
//!       append a chat message. `0` ok; `-1` unknown handle / generating /
//!       bad role. role: 0 = system, 1 = user, 2 = assistant. `len == 0` ok.
//!   session_generate(session) -> i32
//!       start a completion over the whole history. **Non-blocking.** `0` ok;
//!       `-1` unknown handle / already generating / unread reply bytes pending.
//!   session_read(session, ptr, cap) -> i32
//!       streamed reply text. `cap <= 0` probes the unread byte count
//!       (idempotent, does not consume); `cap > 0` copies `min(cap, unread)`,
//!       consumes it, and returns the **bytes written** (`0` = nothing
//!       available). Stream semantics — deliberately NOT `read_line`'s
//!       total-length semantics. `-1` unknown handle.
//!   session_state(session) -> i32
//!       `0` idle, `1` generating, `-1` unknown handle.
//!   session_cancel(session) -> i32
//!       stop the in-flight generation, keep partial text readable. `0` ok;
//!       `-1` unknown handle / not generating.
//!   session_close(session) -> i32
//!       stop the session, free model + context, invalidate the handle. `0`
//!       ok; `-1` unknown/already closed. Also closed by the gate's `Drop`
//!       (game exit = "handle discarded").
//!   session_reset(session) -> i32
//!       clear history and discard unread text. `0` ok; `-1` unknown /
//!       generating.
//!
//! Guest polling loop: `while (state(s) == 1 || read(s, buf, cap) > 0) { ... }`.
//!
//! # UTF-8 guarantee
//!
//! The guest is only ever handed **complete UTF-8 codepoints**: adapters
//! decode token pieces through an incremental UTF-8 decoder and buffer any
//! trailing partial codepoint until the next token completes it. A guest may
//! therefore always `String.UTF8.decodeUnsafe` a buffer it just read. This
//! mirrors `tension::io`'s "the guest never requests a partial line" property
//! — a consequence of the contract, not a separate fix.
//!
//! # Wire format: `argmap` (binary TLV, little-endian) — hand-rolled, NO serde
//!
//! `session_create` takes a flat `argmap`, decoded here with a hand-rolled
//! codec so the host carries no serialization dependency.
//!
//! ```text
//! argmap := u32 entry_count
//! entry  := u8 key_len, key[key_len] (UTF-8), u8 tag, payload
//! tag 1 = bool   : u8 (0/1)
//! tag 2 = i64    : i64 LE
//! tag 3 = f64    : f64 LE (IEEE-754 bits)
//! tag 4 = string : u32 byte_len, bytes (UTF-8, NOT nul-terminated)
//! tag 5 = blob   : u32 byte_len, u32 guest_ptr   (guest linear memory)
//! ```
//!
//! Duplicate keys: last wins. Unknown keys: ignored with a
//! `[tension:ai] ignoring unknown key 'x'` note. Malformed or truncated
//! payloads fail the whole `session_create` (`0`). Blob bytes are copied into
//! a `Vec<u8>` at the linker boundary — the host never holds a `Caller` past
//! the call.
//!
//! # v1 scope
//!
//! Free text only. Grammar/schema/structured-output keys are deliberately
//! **not exposed**: llama.cpp's grammar sampler aborts the process in the
//! pinned version (`GGML_ASSERT(!stacks.empty())`). That is a version
//! constraint, not a design taste — a later llama.cpp can add it without an
//! ABI change, and therefore without a guest rebuild.
//!
//! Model caching is likewise deferred: each session loads its own model. A
//! host-side cache keyed by resolved config can be added later **without any
//! ABI change**; building it now would be management, which belongs to the
//! guest.

use wasmtime::{Caller, Linker};

use crate::HostState;

/// Headless deterministic adapter. The no-feature fallback, the test adapter,
/// and the reference implementation of the contract.
#[cfg(any(not(feature = "ai"), test))]
pub mod stub;
/// Real adapter (llama.cpp via `llama-cpp-2`), in-process.
#[cfg(feature = "ai")]
pub mod llama;

/// Maximum number of concurrently live sessions. Documented constant;
/// `session_create` returns `0` when full.
pub const MAX_SESSIONS: usize = 4;

/// Which model a session loads: exactly one of these is set.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BlobRef {
    /// Number of bytes the blob claims.
    pub len: u32,
    /// Guest linear-memory offset of the first blob byte.
    pub ptr: u32,
}

/// A decoded `argmap` value; the tag byte selects the variant.
#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Bool(bool),
    I64(i64),
    F64(f64),
    Str(Vec<u8>),
    Blob { len: u32, ptr: u32 },
}

/// Decode an `argmap` into its entries, in wire order. Duplicates are kept
/// (the config layer applies last-wins); any malformed input is an error, and
/// the caller turns that into `session_create -> 0`.
pub fn parse_argmap(bytes: &[u8]) -> Result<Vec<(String, Value)>, String> {
    let mut c = Cursor { buf: bytes, pos: 0 };
    let count = c.u32()? as usize;
    // Each entry needs at least key_len + tag = 2 bytes; a count larger than
    // the remaining payload cannot be honest, and bounding it here keeps a
    // hostile blob from driving a huge allocation.
    if count > c.remaining() {
        return Err(format!("entry_count {count} exceeds payload ({} bytes left)", c.remaining()));
    }
    let mut out = Vec::with_capacity(count);
    for _ in 0..count {
        let klen = c.u8()? as usize;
        let key = c.take(klen)?;
        let key = std::str::from_utf8(key)
            .map_err(|_| "key is not valid UTF-8".to_string())?
            .to_string();
        let tag = c.u8()?;
        let value = match tag {
            1 => Value::Bool(c.u8()? != 0),
            2 => Value::I64(c.i64()?),
            3 => Value::F64(f64::from_bits(c.u64()?)),
            4 => {
                let n = c.u32()? as usize;
                Value::Str(c.take(n)?.to_vec())
            }
            5 => {
                let len = c.u32()?;
                let ptr = c.u32()?;
                Value::Blob { len, ptr }
            }
            other => return Err(format!("unknown tag {other} for key '{key}'")),
        };
        out.push((key, value));
    }
    if c.remaining() != 0 {
        return Err(format!("{} trailing byte(s) after argmap", c.remaining()));
    }
    Ok(out)
}

/// A bounds-checked reader over the raw argmap bytes.
struct Cursor<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Cursor<'a> {
    fn remaining(&self) -> usize {
        self.buf.len() - self.pos
    }
    fn take(&mut self, n: usize) -> Result<&'a [u8], String> {
        if n > self.remaining() {
            return Err(format!("truncated payload (wanted {n}, {} left)", self.remaining()));
        }
        let s = &self.buf[self.pos..self.pos + n];
        self.pos += n;
        Ok(s)
    }
    fn u8(&mut self) -> Result<u8, String> {
        Ok(self.take(1)?[0])
    }
    fn u32(&mut self) -> Result<u32, String> {
        let b = self.take(4)?;
        Ok(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }
    fn u64(&mut self) -> Result<u64, String> {
        let b = self.take(8)?;
        Ok(u64::from_le_bytes([b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]]))
    }
    fn i64(&mut self) -> Result<i64, String> {
        Ok(self.u64()? as i64)
    }
}

/// The decoded, validated session configuration. Defaults come from the
/// spec's key table; an adapter is only ever handed a config that passed
/// [`AiConfig::from_argmap`].
#[derive(Debug, Clone)]
pub struct AiConfig {
    /// `model.path`: a GGUF file on the host filesystem.
    pub model_path: Option<String>,
    /// `model.blob`: GGUF bytes in guest memory (copied at the boundary).
    pub model_blob: Option<BlobRef>,
    /// `model.gpu_layers` (default 0).
    pub gpu_layers: i64,
    /// `context.size` (default 2048).
    pub ctx_size: i64,
    /// `context.threads` (default 0 = crate default).
    pub threads: i64,
    /// `context.batch` (default 512).
    pub batch: i64,
    /// `sampler.temp` (default 0.8).
    pub temp: f64,
    /// `sampler.top_p` (default 0.95).
    pub top_p: f64,
    /// `sampler.top_k` (default 40).
    pub top_k: i64,
    /// `sampler.seed` (default 0).
    pub seed: i64,
    /// `sampler.max_tokens` (default 256).
    pub max_tokens: i64,
    /// `chat.template`: a chat-template **name** override; absent = model default.
    pub chat_template: Option<String>,
}

impl Default for AiConfig {
    fn default() -> Self {
        Self {
            model_path: None,
            model_blob: None,
            gpu_layers: 0,
            ctx_size: 2048,
            threads: 0,
            batch: 512,
            temp: 0.8,
            top_p: 0.95,
            top_k: 40,
            seed: 0,
            max_tokens: 256,
            chat_template: None,
        }
    }
}

impl AiConfig {
    /// Interpret a decoded argmap. Unknown keys are ignored with a note
    /// (last-wins for duplicates, by overwrite); a known key carrying the
    /// wrong type is an error, which fails the whole create — the contract
    /// for a bad dict.
    pub fn from_argmap(entries: &[(String, Value)]) -> Result<Self, String> {
        let mut cfg = AiConfig::default();
        for (key, value) in entries {
            match key.as_str() {
                "model.path" => match value {
                    Value::Str(bytes) => {
                        let path = String::from_utf8_lossy(bytes).into_owned();
                        if path.is_empty() {
                            return Err("model.path is empty".into());
                        }
                        cfg.model_path = Some(path);
                    }
                    other => return Err(type_error(key, "string", other)),
                },
                "model.blob" => match value {
                    Value::Blob { len, ptr } => {
                        cfg.model_blob = Some(BlobRef { len: *len, ptr: *ptr });
                    }
                    other => return Err(type_error(key, "blob", other)),
                },
                "model.gpu_layers" => cfg.gpu_layers = int(key, value)?,
                "context.size" => cfg.ctx_size = int(key, value)?,
                "context.threads" => cfg.threads = int(key, value)?,
                "context.batch" => cfg.batch = int(key, value)?,
                "sampler.temp" => cfg.temp = float(key, value)?,
                "sampler.top_p" => cfg.top_p = float(key, value)?,
                "sampler.top_k" => cfg.top_k = int(key, value)?,
                "sampler.seed" => cfg.seed = int(key, value)?,
                "sampler.max_tokens" => cfg.max_tokens = int(key, value)?,
                "chat.template" => match value {
                    Value::Str(bytes) => {
                        cfg.chat_template = Some(String::from_utf8_lossy(bytes).into_owned());
                    }
                    other => return Err(type_error(key, "string", other)),
                },
                other => log(&format!("ignoring unknown key '{other}'")),
            }
        }

        if cfg.model_path.is_none() && cfg.model_blob.is_none() {
            return Err("no model key (need model.path or model.blob)".into());
        }
        if cfg.ctx_size <= 0 {
            return Err("context.size must be > 0".into());
        }
        if cfg.batch <= 0 {
            return Err("context.batch must be > 0".into());
        }
        if cfg.max_tokens <= 0 {
            return Err("sampler.max_tokens must be > 0".into());
        }
        if cfg.threads < 0 {
            return Err("context.threads must be >= 0".into());
        }
        if !cfg.temp.is_finite() || cfg.temp < 0.0 {
            return Err("sampler.temp must be finite and >= 0".into());
        }
        if !cfg.top_p.is_finite() || cfg.top_p <= 0.0 || cfg.top_p > 1.0 {
            return Err("sampler.top_p must be in (0, 1]".into());
        }
        if cfg.top_k < 0 {
            return Err("sampler.top_k must be >= 0".into());
        }
        Ok(cfg)
    }

    /// Short description of the model source, for the ABI trace.
    pub fn model_desc(&self) -> String {
        match (&self.model_path, self.model_blob) {
            (Some(p), _) => format!("path:{p}"),
            (None, Some(b)) => format!("blob:{}", b.len),
            (None, None) => "none".into(),
        }
    }
}

fn type_error(key: &str, want: &str, got: &Value) -> String {
    let got = match got {
        Value::Bool(_) => "bool",
        Value::I64(_) => "i64",
        Value::F64(_) => "f64",
        Value::Str(_) => "string",
        Value::Blob { .. } => "blob",
    };
    format!("key '{key}' wants {want}, got {got}")
}

/// Integer-valued key. An `f64` payload is accepted only when it is integral,
/// so an SDK that widens a whole number cannot accidentally be rejected.
fn int(key: &str, value: &Value) -> Result<i64, String> {
    match value {
        Value::I64(v) => Ok(*v),
        Value::F64(v) if v.is_finite() && v.fract() == 0.0 => Ok(*v as i64),
        other => Err(type_error(key, "i64", other)),
    }
}

/// Float-valued key. An `i64` payload widens losslessly, so integer literals
/// work without a cast.
fn float(key: &str, value: &Value) -> Result<f64, String> {
    match value {
        Value::F64(v) => Ok(*v),
        Value::I64(v) => Ok(*v as f64),
        other => Err(type_error(key, "f64", other)),
    }
}

/// A host event line: `[tension:ai] <message>`. Always on — these are the
/// low-volume lifecycle and failure lines (model loading, load timing, refused
/// configs, template fallbacks, generation errors) that tell a user what the
/// model is doing.
pub(crate) fn log(msg: &str) {
    eprintln!("[tension:ai] {msg}");
}

/// A per-call ABI trace line: `[tension:ai] <verb>(<args>) -> <ret>`.
///
/// Off by default, because a guest draining a reply polls `session_state` /
/// `session_read` in a tight loop — the example drain loop makes millions of
/// calls over one generation — and tracing every one of them buries [`log`]'s
/// lifecycle lines (and llama.cpp's model-loading output) under hundreds of
/// megabytes of stderr. Set `TENSION_AI_TRACE=1` for the full per-call stream.
pub(crate) fn trace(call: &str) {
    use std::sync::OnceLock;
    static ENABLED: OnceLock<bool> = OnceLock::new();
    let enabled = *ENABLED.get_or_init(|| {
        matches!(
            std::env::var("TENSION_AI_TRACE").as_deref(),
            Ok("1") | Ok("true") | Ok("yes")
        )
    });
    if enabled {
        eprintln!("[tension:ai] {call}");
    }
}

/// What any AI adapter must do. The [`AiSession`] gate above owns the shared
/// contract (handle bookkeeping, the session cap, the ABI trace); adapters
/// own only their mechanics. Every method returns the raw ABI code.
///
/// `read_pending` / `read_consume` are split so the gate can implement
/// `session_read`'s probe-vs-consume asymmetry without the adapter needing
/// guest memory: probe is a pure query, consume hands back the bytes it took.
pub trait AiAdapter {
    /// Load the model and open a session. `blob` carries the copied
    /// `model.blob` bytes when the config named a blob source. `Err` becomes
    /// `session_create -> 0`; the message goes to the ABI trace.
    fn create(&mut self, cfg: &AiConfig, blob: Option<&[u8]>) -> Result<i32, String>;
    /// Append a chat message. `0` ok, `-1` unknown handle / generating / bad role.
    fn add(&mut self, session: i32, role: i32, text: &str) -> i32;
    /// Start a completion (non-blocking). `0` ok, `-1` unknown / generating / undrained.
    fn generate(&mut self, session: i32) -> i32;
    /// `0` idle, `1` generating, `-1` unknown handle.
    fn state(&mut self, session: i32) -> i32;
    /// Unread reply byte count, or `None` for an unknown handle.
    fn read_pending(&mut self, session: i32) -> Option<usize>;
    /// Consume up to `cap` bytes of reply text, or `None` for an unknown
    /// handle. Consuming less than `cap` is normal: `cap` is a ceiling.
    fn read_consume(&mut self, session: i32, cap: i32) -> Option<Vec<u8>>;
    /// Stop the in-flight generation, keep partial text. `0` ok, `-1` unknown / idle.
    fn cancel(&mut self, session: i32) -> i32;
    /// Clear history and discard unread text. `0` ok, `-1` unknown / generating.
    fn reset(&mut self, session: i32) -> i32;
    /// Stop the session and free its resources. `0` ok, `-1` unknown/already closed.
    fn close(&mut self, session: i32) -> i32;
    /// Close every live session (gate `Drop`: game exit = handle discarded).
    fn close_all(&mut self);
}

/// The session gate: holds the adapter and enforces the shared contract —
/// the concurrent-session cap, the live-handle set behind it, and the trace.
pub struct AiSession {
    adapter: Box<dyn AiAdapter>,
    live: Vec<i32>,
}

impl AiSession {
    pub fn new(adapter: Box<dyn AiAdapter>) -> Self {
        Self { adapter, live: Vec::new() }
    }

    pub fn create(&mut self, cfg: &AiConfig, blob: Option<&[u8]>) -> i32 {
        if self.live.len() >= MAX_SESSIONS {
            log(&format!("session_create -> 0 (session limit {MAX_SESSIONS} reached)"));
            return 0;
        }
        match self.adapter.create(cfg, blob) {
            Ok(handle) => {
                self.live.push(handle);
                log(&format!(
                    "session_create(model={}, ctx={}) -> {handle}",
                    cfg.model_desc(),
                    cfg.ctx_size
                ));
                handle
            }
            Err(msg) => {
                log(&format!("session_create(model={}) -> 0 ({msg})", cfg.model_desc()));
                0
            }
        }
    }

    pub fn add(&mut self, session: i32, role: i32, text: &str) -> i32 {
        let ret = self.adapter.add(session, role, text);
        log(&format!(
            "session_add(session={session}, role={role}, len={}) -> {ret}",
            text.len()
        ));
        ret
    }

    pub fn generate(&mut self, session: i32) -> i32 {
        let ret = self.adapter.generate(session);
        log(&format!("session_generate(session={session}) -> {ret}"));
        ret
    }

    pub fn state(&mut self, session: i32) -> i32 {
        let ret = self.adapter.state(session);
        trace(&format!("session_state(session={session}) -> {ret}"));
        ret
    }

    /// `cap <= 0`: probe. Returns the unread byte count, or `-1`.
    pub fn read_probe(&mut self, session: i32) -> i32 {
        let ret = match self.adapter.read_pending(session) {
            Some(n) => n as i32,
            None => -1,
        };
        trace(&format!("session_read(session={session}, probe) -> {ret}"));
        ret
    }

    /// `cap > 0`: consume up to `cap` bytes. `None` = unknown handle.
    pub fn read_consume(&mut self, session: i32, cap: i32) -> Option<Vec<u8>> {
        let chunk = self.adapter.read_consume(session, cap);
        match &chunk {
            Some(bytes) => trace(&format!(
                "session_read(session={session}, cap={cap}) -> {}",
                bytes.len()
            )),
            None => trace(&format!("session_read(session={session}, cap={cap}) -> -1")),
        }
        chunk
    }

    pub fn cancel(&mut self, session: i32) -> i32 {
        let ret = self.adapter.cancel(session);
        log(&format!("session_cancel(session={session}) -> {ret}"));
        ret
    }

    pub fn reset(&mut self, session: i32) -> i32 {
        let ret = self.adapter.reset(session);
        log(&format!("session_reset(session={session}) -> {ret}"));
        ret
    }

    pub fn close(&mut self, session: i32) -> i32 {
        let ret = self.adapter.close(session);
        if ret == 0 {
            self.live.retain(|&h| h != session);
        }
        log(&format!("session_close(session={session}) -> {ret}"));
        ret
    }

    /// Live session handles, in creation order (used by tests).
    #[cfg(test)]
    pub fn live_handles(&self) -> Vec<i32> {
        self.live.clone()
    }
}

impl Drop for AiSession {
    fn drop(&mut self) {
        // The guest exiting without session_close is not a leak: the store
        // dropping the gate closes every live session (documented in the
        // close verb — game exit is "handle discarded").
        self.adapter.close_all();
    }
}

/// Read `len` bytes at `ptr` from guest memory, clamped to the memory bounds
/// (the same defensive pattern as the `io` and `audio` services). Returns an
/// empty vector for a degenerate request.
fn read_guest_bytes(caller: &mut Caller<'_, HostState>, ptr: i32, len: i32) -> Vec<u8> {
    if ptr <= 0 || len <= 0 {
        return Vec::new();
    }
    let Some(mem) = caller.get_export("memory").and_then(|e| e.into_memory()) else {
        return Vec::new();
    };
    let data = mem.data(&*caller);
    let start = (ptr as usize).min(data.len());
    let end = start.saturating_add(len as usize).min(data.len());
    data[start..end].to_vec()
}

/// Write `bytes` at `ptr` in guest memory, clamped to the bounds. Returns the
/// number of bytes actually written.
fn write_guest_bytes(caller: &mut Caller<'_, HostState>, ptr: i32, bytes: &[u8]) -> i32 {
    if ptr <= 0 {
        return 0;
    }
    let Some(mem) = caller.get_export("memory").and_then(|e| e.into_memory()) else {
        return 0;
    };
    let data = mem.data_mut(&mut *caller);
    let start = (ptr as usize).min(data.len());
    let end = start.saturating_add(bytes.len()).min(data.len());
    let n = end - start;
    data[start..end].copy_from_slice(&bytes[..n]);
    n as i32
}

/// Copy a `model.blob` out of guest memory. `None` means the reference was
/// degenerate or out of bounds — a malformed blob, which fails the create.
fn read_blob(caller: &mut Caller<'_, HostState>, blob: &BlobRef) -> Option<Vec<u8>> {
    if blob.len == 0 {
        return None;
    }
    let mem = caller.get_export("memory").and_then(|e| e.into_memory())?;
    let data = mem.data(&*caller);
    let start = blob.ptr as usize;
    let end = start.checked_add(blob.len as usize)?;
    if end > data.len() {
        return None;
    }
    Some(data[start..end].to_vec())
}

/// Register the eight `tension::ai` imports. The module name is the import
/// module the guest compiles against; nothing here reaches into `io` or
/// `audio`.
pub fn link_ai(linker: &mut Linker<HostState>) -> anyhow::Result<()> {
    linker.func_wrap(
        "tension::ai",
        "session_create",
        |mut caller: Caller<'_, HostState>, cfg_ptr: i32, cfg_len: i32| -> i32 {
            if cfg_len <= 0 {
                log("session_create(cfg_len<=0) -> 0");
                return 0;
            }
            let raw = read_guest_bytes(&mut caller, cfg_ptr, cfg_len);
            let entries = match parse_argmap(&raw) {
                Ok(entries) => entries,
                Err(msg) => {
                    log(&format!("session_create -> 0 (malformed argmap: {msg})"));
                    return 0;
                }
            };
            let cfg = match AiConfig::from_argmap(&entries) {
                Ok(cfg) => cfg,
                Err(msg) => {
                    log(&format!("session_create -> 0 ({msg})"));
                    return 0;
                }
            };
            // Blob bytes are copied here, at the linker boundary, so no
            // `Caller` is ever held past the call.
            let blob = match cfg.model_blob {
                Some(blob) => match read_blob(&mut caller, &blob) {
                    Some(bytes) => Some(bytes),
                    None => {
                        log("session_create -> 0 (model.blob out of guest memory bounds)");
                        return 0;
                    }
                },
                None => None,
            };
            caller.data_mut().ai.create(&cfg, blob.as_deref())
        },
    )?;

    linker.func_wrap(
        "tension::ai",
        "session_add",
        |mut caller: Caller<'_, HostState>, session: i32, role: i32, ptr: i32, len: i32| -> i32 {
            let bytes = read_guest_bytes(&mut caller, ptr, len);
            let text = String::from_utf8_lossy(&bytes).into_owned();
            caller.data_mut().ai.add(session, role, &text)
        },
    )?;

    linker.func_wrap(
        "tension::ai",
        "session_generate",
        |mut caller: Caller<'_, HostState>, session: i32| -> i32 {
            caller.data_mut().ai.generate(session)
        },
    )?;

    linker.func_wrap(
        "tension::ai",
        "session_read",
        |mut caller: Caller<'_, HostState>, session: i32, ptr: i32, cap: i32| -> i32 {
            if cap <= 0 {
                return caller.data_mut().ai.read_probe(session);
            }
            // Consume first (adapter borrow ends), then write to guest memory:
            // the two borrows of `caller` cannot overlap.
            let chunk = match caller.data_mut().ai.read_consume(session, cap) {
                Some(chunk) => chunk,
                None => return -1,
            };
            write_guest_bytes(&mut caller, ptr, &chunk)
        },
    )?;

    linker.func_wrap(
        "tension::ai",
        "session_state",
        |mut caller: Caller<'_, HostState>, session: i32| -> i32 {
            caller.data_mut().ai.state(session)
        },
    )?;

    linker.func_wrap(
        "tension::ai",
        "session_cancel",
        |mut caller: Caller<'_, HostState>, session: i32| -> i32 {
            caller.data_mut().ai.cancel(session)
        },
    )?;

    linker.func_wrap(
        "tension::ai",
        "session_reset",
        |mut caller: Caller<'_, HostState>, session: i32| -> i32 {
            caller.data_mut().ai.reset(session)
        },
    )?;

    linker.func_wrap(
        "tension::ai",
        "session_close",
        |mut caller: Caller<'_, HostState>, session: i32| -> i32 {
            caller.data_mut().ai.close(session)
        },
    )?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Test-only encoder: the host never encodes (only the SDK does), but the
    /// codec tests need to build wire bytes to decode.
    fn enc(entries: &[(&str, Value)]) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(&(entries.len() as u32).to_le_bytes());
        for (key, value) in entries {
            out.push(key.len() as u8);
            out.extend_from_slice(key.as_bytes());
            match value {
                Value::Bool(b) => {
                    out.push(1);
                    out.push(u8::from(*b));
                }
                Value::I64(v) => {
                    out.push(2);
                    out.extend_from_slice(&v.to_le_bytes());
                }
                Value::F64(v) => {
                    out.push(3);
                    out.extend_from_slice(&v.to_bits().to_le_bytes());
                }
                Value::Str(s) => {
                    out.push(4);
                    out.extend_from_slice(&(s.len() as u32).to_le_bytes());
                    out.extend_from_slice(s);
                }
                Value::Blob { len, ptr } => {
                    out.push(5);
                    out.extend_from_slice(&len.to_le_bytes());
                    out.extend_from_slice(&ptr.to_le_bytes());
                }
            }
        }
        out
    }

    #[test]
    fn all_five_tags_round_trip() {
        let entries = vec![
            ("bool".to_string(), Value::Bool(true)),
            ("i64".to_string(), Value::I64(-42)),
            ("f64".to_string(), Value::F64(0.5)),
            ("string".to_string(), Value::Str("héllo".as_bytes().to_vec())),
            ("blob".to_string(), Value::Blob { len: 7, ptr: 4096 }),
        ];
        let raw = enc(&[
            ("bool", Value::Bool(true)),
            ("i64", Value::I64(-42)),
            ("f64", Value::F64(0.5)),
            ("string", Value::Str("héllo".as_bytes().to_vec())),
            ("blob", Value::Blob { len: 7, ptr: 4096 }),
        ]);
        assert_eq!(parse_argmap(&raw).unwrap(), entries);
    }

    #[test]
    fn duplicate_key_keeps_both_and_config_takes_last() {
        let raw = enc(&[
            ("context.size", Value::I64(128)),
            ("context.size", Value::I64(4096)),
            ("model.path", Value::Str(b"/m.gguf".to_vec())),
        ]);
        let entries = parse_argmap(&raw).unwrap();
        assert_eq!(entries.len(), 3); // the codec preserves wire order
        let cfg = AiConfig::from_argmap(&entries).unwrap();
        assert_eq!(cfg.ctx_size, 4096); // ... and the config layer applies last-wins
    }

    #[test]
    fn truncated_payload_fails() {
        // Cut the blob mid-payload, the string mid-bytes, and the header.
        let full = enc(&[
            ("model.path", Value::Str(b"/m.gguf".to_vec())),
            ("model.blob", Value::Blob { len: 4, ptr: 9 }),
        ]);
        for cut in [0, 1, 3, 5, full.len() - 1] {
            assert!(parse_argmap(&full[..cut]).is_err(), "cut {cut} should fail");
        }
        assert!(parse_argmap(&full).is_ok());
    }

    #[test]
    fn lying_entry_count_fails_without_allocating() {
        // entry_count = u32::MAX with no payload behind it.
        let mut raw = u32::MAX.to_le_bytes().to_vec();
        raw.extend_from_slice(b"x");
        assert!(parse_argmap(&raw).is_err());
    }

    #[test]
    fn trailing_bytes_fail() {
        let mut raw = enc(&[("context.size", Value::I64(64))]);
        raw.push(0xAB);
        assert!(parse_argmap(&raw).is_err());
    }

    #[test]
    fn unknown_tag_fails() {
        let mut raw = 1u32.to_le_bytes().to_vec();
        raw.push(1);
        raw.push(b'k');
        raw.push(99); // no such tag
        assert!(parse_argmap(&raw).is_err());
    }

    #[test]
    fn unknown_key_is_ignored_and_config_still_builds() {
        let raw = enc(&[
            ("model.path", Value::Str(b"/m.gguf".to_vec())),
            ("sampler.grammar", Value::Str(b"root ::= x".to_vec())),
        ]);
        let cfg = AiConfig::from_argmap(&parse_argmap(&raw).unwrap()).unwrap();
        assert_eq!(cfg.model_path.as_deref(), Some("/m.gguf"));
    }

    #[test]
    fn defaults_match_the_key_table() {
        let cfg = AiConfig::from_argmap(&parse_argmap(&enc(&[(
            "model.path",
            Value::Str(b"/m.gguf".to_vec()),
        )]))
        .unwrap())
        .unwrap();
        assert_eq!(cfg.gpu_layers, 0);
        assert_eq!(cfg.ctx_size, 2048);
        assert_eq!(cfg.threads, 0);
        assert_eq!(cfg.batch, 512);
        assert_eq!(cfg.temp, 0.8);
        assert_eq!(cfg.top_p, 0.95);
        assert_eq!(cfg.top_k, 40);
        assert_eq!(cfg.seed, 0);
        assert_eq!(cfg.max_tokens, 256);
        assert!(cfg.chat_template.is_none());
    }

    #[test]
    fn empty_dict_and_missing_model_key_fail() {
        assert!(AiConfig::from_argmap(&[]).is_err());
        let entries = parse_argmap(&enc(&[("context.size", Value::I64(512))])).unwrap();
        assert!(AiConfig::from_argmap(&entries).is_err());
    }

    #[test]
    fn numeric_coercion_is_lenient_in_one_direction() {
        let entries = parse_argmap(&enc(&[
            ("model.path", Value::Str(b"/m.gguf".to_vec())),
            ("sampler.temp", Value::I64(1)),
            ("context.size", Value::F64(1024.0)),
        ]))
        .unwrap();
        let cfg = AiConfig::from_argmap(&entries).unwrap();
        assert_eq!(cfg.temp, 1.0);
        assert_eq!(cfg.ctx_size, 1024);
        // A fractional value cannot silently lose its fraction.
        let entries = parse_argmap(&enc(&[
            ("model.path", Value::Str(b"/m.gguf".to_vec())),
            ("context.size", Value::F64(1.5)),
        ]))
        .unwrap();
        assert!(AiConfig::from_argmap(&entries).is_err());
    }
}
