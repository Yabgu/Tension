// Guest-side bindings for the `tension::ai` service.
//
// The host is a low-level chat-session engine: the game names the model,
// writes the conversation, asks for a completion, and drains the reply. The
// host has no model registry, no prompt policy and no agent loop — all of
// that is the game's to own. llama.cpp runs in-process on the host side;
// the guest only ever sees these eight verbs.
//
// `session_create` takes a flat little-endian TLV *argmap* (see the host's
// module docs for the exact wire format). `AiConfig` below is the builder
// that emits those bytes, so game authors never assemble them by hand.
//
// Text crosses the boundary as UTF-8 bytes with an explicit pointer + length,
// exactly like `tension::io`. Replies are guaranteed to contain whole UTF-8
// codepoints, so `String.UTF8.decodeUnsafe` on a freshly read buffer is always
// safe.
//
// Guest polling loop:
//
//   const s = Session.create(cfg);
//   if (s !== null) {
//     s.add(AiRole.User, "hello");
//     s.generate();
//     while (s.state() == 1 || s.read().length > 0) { /* … */ }
//   }

@external("tension::ai", "session_create")
declare function hostSessionCreate(cfgPtr: usize, cfgLen: i32): i32;
@external("tension::ai", "session_add")
declare function hostSessionAdd(session: i32, role: i32, ptr: usize, len: i32): i32;
@external("tension::ai", "session_generate")
declare function hostSessionGenerate(session: i32): i32;
@external("tension::ai", "session_read")
declare function hostSessionRead(session: i32, ptr: usize, cap: i32): i32;
@external("tension::ai", "session_state")
declare function hostSessionState(session: i32): i32;
@external("tension::ai", "session_cancel")
declare function hostSessionCancel(session: i32): i32;
@external("tension::ai", "session_reset")
declare function hostSessionReset(session: i32): i32;
@external("tension::ai", "session_close")
declare function hostSessionClose(session: i32): i32;

/** Chat message roles. The numeric values are the ABI's. */
export enum AiRole {
  System = 0,
  User = 1,
  Assistant = 2,
}

// argmap tag bytes (the wire format's value discriminator).
const TAG_BOOL: u8 = 1;
const TAG_I64: u8 = 2;
const TAG_F64: u8 = 3;
const TAG_STRING: u8 = 4;
const TAG_BLOB: u8 = 5;

// --- payload encoders ------------------------------------------------------

function tagString(text: string): ArrayBuffer {
  const utf8 = String.UTF8.encode(text);
  const buf = new ArrayBuffer(4 + utf8.byteLength);
  new DataView(buf).setUint32(0, utf8.byteLength, true);
  const dst = Uint8Array.wrap(buf);
  const src = Uint8Array.wrap(utf8);
  for (let i = 0; i < src.length; i++) dst[4 + i] = src[i];
  return buf;
}

function tagI64(value: i64): ArrayBuffer {
  const buf = new ArrayBuffer(8);
  new DataView(buf).setInt64(0, value, true);
  return buf;
}

function tagF64(value: f64): ArrayBuffer {
  const buf = new ArrayBuffer(8);
  new DataView(buf).setFloat64(0, value, true);
  return buf;
}

function tagBlob(bytes: ArrayBuffer): ArrayBuffer {
  const buf = new ArrayBuffer(8);
  const view = new DataView(buf);
  view.setUint32(0, bytes.byteLength, true); // byte_len
  view.setUint32(4, <u32>changetype<usize>(bytes), true); // guest_ptr
  return buf;
}

// --- config builder --------------------------------------------------------

/**
 * Builds the `session_create` argmap. Every key in the ABI's config table has
 * a typed setter; the builder emits exactly the keys that were set (the host
 * applies its own defaults), so game authors never touch wire bytes.
 *
 *   const cfg = new AiConfig()
 *     .modelPath("models/llama.gguf")
 *     .contextSize(4096)
 *     .temp(0.7);
 */
export class AiConfig {
  private names: Array<string> = [];
  private tags: Array<u8> = [];
  private payloads: Array<ArrayBuffer> = [];
  /**
   * Keeps the `model.blob` ArrayBuffer reachable until `Session.create` has
   * run: the argmap carries only its pointer, so the config must not let it
   * be collected (or moved) in between.
   */
  private blob: ArrayBuffer | null = null;

  private put(name: string, tag: u8, payload: ArrayBuffer): AiConfig {
    this.names.push(name);
    this.tags.push(tag);
    this.payloads.push(payload);
    return this;
  }

  /** `model.path` — a GGUF file on the host filesystem. */
  modelPath(path: string): AiConfig {
    return this.put("model.path", TAG_STRING, tagString(path));
  }

  /** `model.blob` — GGUF bytes already in guest memory. */
  modelBlob(bytes: ArrayBuffer): AiConfig {
    this.blob = bytes;
    return this.put("model.blob", TAG_BLOB, tagBlob(bytes));
  }

  /** `model.gpu_layers` (host default 0). */
  gpuLayers(n: i64): AiConfig {
    return this.put("model.gpu_layers", TAG_I64, tagI64(n));
  }

  /** `context.size` (host default 2048). */
  contextSize(n: i64): AiConfig {
    return this.put("context.size", TAG_I64, tagI64(n));
  }

  /** `context.threads` (host default 0 = crate default). */
  threads(n: i64): AiConfig {
    return this.put("context.threads", TAG_I64, tagI64(n));
  }

  /** `context.batch` (host default 512). */
  batch(n: i64): AiConfig {
    return this.put("context.batch", TAG_I64, tagI64(n));
  }

  /** `sampler.temp` (host default 0.8). */
  temp(v: f64): AiConfig {
    return this.put("sampler.temp", TAG_F64, tagF64(v));
  }

  /** `sampler.top_p` (host default 0.95). */
  topP(v: f64): AiConfig {
    return this.put("sampler.top_p", TAG_F64, tagF64(v));
  }

  /** `sampler.top_k` (host default 40). */
  topK(n: i64): AiConfig {
    return this.put("sampler.top_k", TAG_I64, tagI64(n));
  }

  /** `sampler.seed` (host default 0). */
  seed(n: i64): AiConfig {
    return this.put("sampler.seed", TAG_I64, tagI64(n));
  }

  /** `sampler.max_tokens` (host default 256). */
  maxTokens(n: i64): AiConfig {
    return this.put("sampler.max_tokens", TAG_I64, tagI64(n));
  }

  /** `chat.template` — a chat-template name override; absent = model default. */
  chatTemplate(name: string): AiConfig {
    return this.put("chat.template", TAG_STRING, tagString(name));
  }

  /** Encode the argmap for `session_create`. */
  toBytes(): ArrayBuffer {
    let size = 4;
    for (let i = 0; i < this.names.length; i++) {
      size += 1 + String.UTF8.byteLength(this.names[i]) + 1 + this.payloads[i].byteLength;
    }
    const buf = new ArrayBuffer(size);
    const view = new DataView(buf);
    view.setUint32(0, this.names.length, true);
    let off = 4;
    for (let i = 0; i < this.names.length; i++) {
      const key = String.UTF8.encode(this.names[i]);
      const kb = Uint8Array.wrap(key);
      view.setUint8(off, <u8>key.byteLength);
      off += 1;
      for (let j = 0; j < kb.length; j++) view.setUint8(off + j, kb[j]);
      off += key.byteLength;
      view.setUint8(off, this.tags[i]);
      off += 1;
      const pb = Uint8Array.wrap(this.payloads[i]);
      for (let j = 0; j < pb.length; j++) view.setUint8(off + j, pb[j]);
      off += this.payloads[i].byteLength;
    }
    return buf;
  }
}

// --- session ---------------------------------------------------------------

/**
 * A live chat session. Create one with `Session.create`; every other method
 * maps 1:1 onto an ABI verb and returns `false` where the verb returns `-1`.
 *
 *   const s = Session.create(cfg);
 *   if (s !== null) {
 *     s.add(AiRole.System, "You narrate a haunted house.");
 *     s.add(AiRole.User, "I open the door.");
 *     if (s.generate()) {
 *       while (s.state() == 1 || s.read().length > 0) { ... }
 *     }
 *     s.close();
 *   }
 */
export class Session {
  private handle: i32;

  private constructor(handle: i32) {
    this.handle = handle;
  }

  /**
   * Open a session. Blocking on the host (the model load happens here).
   * Returns `null` when the host refuses: a malformed dict, no model key, a
   * model that failed to load, or the session cap (4) already held.
   */
  static create(cfg: AiConfig): Session | null {
    const bytes = cfg.toBytes();
    const handle = hostSessionCreate(changetype<usize>(bytes), bytes.byteLength);
    return handle > 0 ? new Session(handle) : null;
  }

  /** Append a chat message. `false` on an unknown handle, bad role, or while generating. */
  add(role: AiRole, text: string): bool {
    const bytes = String.UTF8.encode(text);
    return hostSessionAdd(this.handle, <i32>role, changetype<usize>(bytes), bytes.byteLength) == 0;
  }

  /**
   * Start a completion over the whole history. Non-blocking: the host returns
   * immediately and generates on its own thread. `false` when the handle is
   * unknown, a generation is already in flight, or reply bytes are still
   * undrained (drain them first).
   */
  generate(): bool {
    return hostSessionGenerate(this.handle) == 0;
  }

  /**
   * Read and consume all reply text currently buffered, using the ABI's
   * probe-then-consume pattern. Blocks nothing; returns `""` when there is
   * nothing to read (or the handle is unknown).
   *
   * A returned string is always whole UTF-8 codepoints — the host buffers any
   * trailing partial codepoint until a later token completes it.
   */
  read(): string {
    let text = "";
    while (true) {
      const unread = hostSessionRead(this.handle, 0, 0); // probe: no consume
      if (unread <= 0) break;
      const buf = new ArrayBuffer(unread);
      const got = hostSessionRead(this.handle, changetype<usize>(buf), unread);
      if (got <= 0) break;
      text += String.UTF8.decodeUnsafe(changetype<usize>(buf), got);
    }
    return text;
  }

  /** `0` idle, `1` generating, `-1` unknown handle. */
  state(): i32 {
    return hostSessionState(this.handle);
  }

  /** Stop the in-flight generation; already-streamed text stays readable. */
  cancel(): bool {
    return hostSessionCancel(this.handle) == 0;
  }

  /** Clear the history and discard unread text. `false` while generating. */
  reset(): bool {
    return hostSessionReset(this.handle) == 0;
  }

  /**
   * Stop the session and free the model + context on the host side. Safe to
   * call twice; the second call is a no-op. The host also closes every live
   * session when the game exits, so a forgotten `close()` is not a leak.
   */
  close(): void {
    if (this.handle > 0) {
      hostSessionClose(this.handle);
      this.handle = 0;
    }
  }
}
