/**
 * TensionCore guest SDK — TypeScript declarations for AssemblyScript game
 * sources.
 *
 * The implementation is AssemblyScript: `assembly/index.ts` re-exports the
 * `tension::io`, `tension::audio` and `tension::ai` bindings from
 * `assembly/*.ts`, compiled into the game's wasm by `asc`. This file only
 * describes the surface so editors and other tooling can type game sources;
 * there is no second, runnable surface.
 */

export declare function write(text: string): void;
export declare function print(text: string): void;
export declare function readLine(): string | null;
export declare function argCount(): i32;
export declare function arg(i: i32): string;

export declare function audioInit(sampleRate: i32, channels: i32): i32;
export declare function audioPlay(pcm: Float32Array, rate: i32, gain: f32, looping: bool): i32;
export declare function audioStop(voice: i32): i32;
export declare function audioSetGain(voice: i32, gain: f32): i32;
export declare function audioVoiceState(voice: i32): i32;
export declare function audioShutdown(): i32;

/** Chat message roles; the numeric values are the ABI's. */
export declare enum AiRole {
  System = 0,
  User = 1,
  Assistant = 2,
}

/**
 * Builder for the `session_create` argmap. Every config key has a typed
 * setter; the host applies its own defaults, so set only what you mean.
 */
export declare class AiConfig {
  modelPath(path: string): AiConfig;
  modelBlob(bytes: ArrayBuffer): AiConfig;
  gpuLayers(n: i64): AiConfig;
  contextSize(n: i64): AiConfig;
  threads(n: i64): AiConfig;
  batch(n: i64): AiConfig;
  temp(v: f64): AiConfig;
  topP(v: f64): AiConfig;
  topK(n: i64): AiConfig;
  seed(n: i64): AiConfig;
  maxTokens(n: i64): AiConfig;
  chatTemplate(name: string): AiConfig;
  toBytes(): ArrayBuffer;
}

/** A live chat session: one handle, one in-flight generation at a time. */
export declare class Session {
  static create(cfg: AiConfig): Session | null;
  add(role: AiRole, text: string): bool;
  generate(): bool;
  read(): string;
  state(): i32;
  cancel(): bool;
  reset(): bool;
  close(): void;
}
