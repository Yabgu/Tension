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

// ---- tension::res — the read-only resource VFS (ECMA-208 paks) -----------
//
// Strict VFS, lenient framework: a path that does not resolve (including every
// path when no pak is loaded) is `null` / `[]` / `false` / -1 — never an
// exception. `readdir` returns raw NS1 names; the `/` suffix on directories is
// applied here, for game authors.

export declare const RES_SEEK_SET: i32;
export declare const RES_SEEK_CUR: i32;
export declare const RES_SEEK_END: i32;
export declare const RES_KIND_FILE: u32;
export declare const RES_KIND_DIRECTORY: u32;
export declare const RES_FLAG_COMPRESSED: u32;

export declare class ResEntry {
  name: string;
  isDir: bool;
  /** The expanded payload size: a compressed File reads back at this length. */
  size: i32;
  /** Whether the File is stored compressed; `read` expands it either way. */
  isCompressed: bool;
  constructor(name: string, isDir: bool, size: i32, isCompressed?: bool);
  pathIn(parent: string): string;
}

export declare function resStat(path: string): ResEntry | null;
export declare function resExists(path: string): bool;
export declare function resIsDir(path: string): bool;
export declare function resSize(path: string): i32;
export declare function resEntries(path?: string): ResEntry[];
export declare function resList(path?: string): string[];
export declare function resReadFile(path: string): Uint8Array | null;
export declare function resReadText(path: string): string | null;

export declare class ResFile {
  static open(path: string): ResFile | null;
  rawFd(): i32;
  isOpen(): bool;
  read(buf: Uint8Array): i32;
  readAll(): Uint8Array;
  seek(offset: i32, whence?: i32): i32;
  tell(): i32;
  size(): i32;
  close(): void;
}

// ---- tension::solver — the numerical solver coprocessor ------------------
//
// Five imports (GUEST_ABI.md): create, step, state, set_state, destroy. The
// guest passes `_derivative` / `deriv_buf_in` / `deriv_buf_out` to `create`
// in a `SolverCallbacks` object; under `source: "wasm"` the host resolves
// them from the module's exported `table` (build with `asc --exportTable`).
// Errors are null / -1, never exceptions. `state` writes `[t, y0, y1, ...]`;
// `setState` takes `t` and `y` separately, because a checkpoint is `{t, y}`.

/** The three callbacks a `source: "wasm"` solver uses; ignored otherwise. */
export declare class SolverCallbacks {
  derivative: (yPtr: usize, len: i32, t: f64, dyPtr: usize, dyCap: i32) => i32;
  bufIn: () => i32;
  bufOut: () => i32;
}

export declare class Solver {
  static create(configJson: string, callbacks?: SolverCallbacks | null): Solver | null;
  step(dt: f64): i32;
  state(out: Float64Array): i32;
  setState(t: f64, y: Float64Array): i32;
  destroy(): void;
  isOpen(): bool;
}
