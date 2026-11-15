// tension-framework/assembly/dev.ts — `tension::dev`, the nested-guest verbs.
//
// A guest that the host drives is a **run**: `dev.run` starts it, `dev.frame`
// advances it one frame, `dev.read` copies the frame it produced, and `dev.stop`
// ends it. The host side is `tension-core/src/host/dev.rs`; the contract a guest
// on the other end must satisfy is `docs/modules/2d.md` §7.5.
//
// ## Two buffers, and neither hands out an address
//
// The verbs cross a *destination*: `read(run, ptr, cap)` and `out(run, ptr, cap)`
// both fill guest memory and answer the byte length, with `cap <= 0` as the size
// probe. So a caller has to own a buffer, and this module is where that buffer
// has a type:
//
// * **`readFrame` takes a `RecordBuffer`** — the same class a scene packs into,
//   from `2d/buffers.ts`. It is already the framework's answer to "a frame's
//   worth of records, with the count owned by the buffer", so the count a
//   submission uses is the count the fill wrote, by construction. No second
//   buffer type, and no `(ptr, count)` pair that can disagree.
// * **`out` takes an `OutBuffer`** — bytes, decoded on demand.
//
// **Not named `TextBuffer`.** `ui/text.ts` already owns that name (the widget's
// text editing buffer) and `index.ts` re-exports both modules, so a second
// `TextBuffer` is a duplicate export. `OutBuffer` is what this one holds: the
// bytes a run *printed*.
//
// Neither hands an address to guest code: `RecordBuffer.address()` and
// `OutBuffer.address()` are framework-internal, exactly as `Bytes.address()` is
// (`bytes.ts` records the fault that rule prevents — a record buffer addressed
// with `changetype<usize>(view)` corrupts the collector's link word and traps in
// the *next* mark phase).
//
// ## Why `readFrame` is whole-frame-or-nothing
//
// The host refuses a fill that would not fit (`-ENOSPC`) rather than truncating,
// and this wrapper checks the capacity first so the refusal is a return value
// rather than a half-written buffer. Half a frame draws the top of a scene and
// reads as a renderer bug; the refusal names the number instead.
//
// ## Page numbers arrive translated
//
// `read` copies the frame with each record's `tex` already moved to the page
// numbering of the device the *outer* guest draws on (`render2d/device.rs`,
// `forward_into`). A caller submits the bytes as they arrive and does not add a
// page base of its own — doing that twice is the one arithmetic this ABI removes.

import { Bytes } from "./bytes";
import { RecordBuffer } from "./2d/buffers";
import { RECORD_SIZE } from "./2d/types";

// --- the imports (module "tension::dev") ------------------------------------
//
// Every parameter is `i32` except `run`'s width/height, which the header
// declares `u32` (a nested guest may draw into a rectangle, and the rectangle is
// unsigned). The shapes are `host/dev.rs`'s registrations, verbatim.

/** `dev.run(path_ptr, path_len, flags, width, height) -> run_id | -errno`. */
@external("tension::dev", "run")
declare function runRaw(
  pathPtr: i32,
  pathLen: i32,
  flags: i32,
  width: u32,
  height: u32,
): i32;

/** `dev.frame(run_id) -> 1 still running | 0 complete | -errno`. */
@external("tension::dev", "frame")
declare function frameRaw(id: i32): i32;

/** `dev.read(run_id, ptr, cap) -> byte length (cap <= 0 probes) | bytes | -errno`. */
@external("tension::dev", "read")
declare function readRaw(id: i32, ptr: i32, cap: i32): i32;

/** `dev.stop(run_id) -> 0 | -errno`. */
@external("tension::dev", "stop")
declare function stopRaw(id: i32): i32;

/** `dev.out(run_id, ptr, cap) -> byte length (cap <= 0 probes) | bytes | -errno`. */
@external("tension::dev", "out")
declare function outRaw(id: i32, ptr: i32, cap: i32): i32;

/** `dev.pipe(run_id, nested_pipe) -> the pipeline id on this device | -errno`. */
@external("tension::dev", "pipe")
declare function pipeRaw(id: i32, nested: i32): i32;

// --- the flags -------------------------------------------------------------

/** The entrypoint is the whole program. Never refused. */
export const RUN_BATCH: i32 = 1;
/**
 * The entrypoint returns, then the caller drives frames.
 *
 * Refused for a module that exports no `_game_running`: such a guest would
 * return from its entrypoint, never be driven, and exit having done nothing —
 * which reads as success. `docs/modules/2d.md` §7.5.
 */
export const RUN_RENDERING: i32 = 2;

// --- buffers ---------------------------------------------------------------

/**
 * The bytes a run printed, and the length `out` wrote.
 *
 * Capacity is a runtime value (`Bytes` is a heap object), so a caller sizes it
 * from what it expects rather than from a compile-time constant.
 */
export class OutBuffer {
  private bytes: Bytes;
  /** Bytes `out` wrote. Not the capacity — the length of what was actually there. */
  length: i32 = 0;

  constructor(capacity: i32) {
    const cap = capacity > 0 ? capacity : 0;
    this.bytes = Bytes.allocate(cap);
  }

  /** For symmetry with the rest of the SDK, which spells construction `create`. */
  static create(capacity: i32): OutBuffer {
    return new OutBuffer(capacity);
  }

  /** How many bytes it can hold. */
  byteLength(): i32 {
    return this.bytes.length;
  }

  /** One byte of what `out` wrote; 0 past `length`. */
  byteAt(index: i32): u8 {
    return index >= 0 && index < this.length ? this.bytes.byteAt(index) : 0;
  }

  /** What `out` wrote, as text. Exactly `length` bytes — not the capacity. */
  text(): string {
    if (this.length <= 0) return "";
    return String.UTF8.decodeUnsafe(this.bytes.address(), this.length);
  }

  /** The destination address, for `dev.out`. Framework use; see `Bytes.address`. */
  address(): usize {
    return this.bytes.address();
  }
}

// --- the run ---------------------------------------------------------------

/**
 * One run, as the guest that started it sees it.
 *
 * An invalid run (`id <= 0`) is still a usable object: every method refuses with
 * the same errno the verb would have returned, so a caller that forgot to check
 * gets a clean refusal rather than an error about run 0.
 */
export class DevRun {
  /** The run id the host issued: > 0 for a run, an errno for a refusal. */
  id: i32;

  constructor(id: i32) {
    this.id = id;
  }

  /** Whether `dev.run` accepted this run. */
  isValid(): bool {
    return this.id > 0;
  }

  /** The refusal `dev.run` answered with, or 0. */
  lastError(): i32 {
    return this.id > 0 ? 0 : this.id;
  }

  /**
   * Advance one frame: `1` still running, `0` complete, `< 0` an errno.
   *
   * **One call is one frame**, and it returns only once the guest presented one
   * (`host/dev.rs` — `Sandbox::frame`), so a mid-frame yield cannot hand the
   * caller a torn frame. A negative answer means the guest trapped, and the run
   * stays in the registry: the frame it built before trapping is still readable.
   */
  frame(): i32 {
    if (!this.isValid()) return this.id;
    return frameRaw(this.id);
  }

  /**
   * Copy the last completed frame into `into`, page numbers already translated.
   *
   * Answers the byte length written, or an errno. `-ENOSPC` means the buffer is
   * smaller than the frame — probe first with `frameBytes()` if the size is not
   * known.
   */
  readFrame(into: RecordBuffer): i32 {
    if (!this.isValid()) return this.id;
    const need = readRaw(this.id, 0, 0);
    if (need < 0) return need;
    const have = into.byteLength();
    if (need > have) return -28; // ENOSPC: the frame does not fit
    const written = readRaw(this.id, <i32>into.address(), have);
    if (written < 0) return written;
    into.setCount(written / <i32>RECORD_SIZE);
    return written;
  }

  /** The byte length of the last completed frame, without copying it. */
  frameBytes(): i32 {
    if (!this.isValid()) return this.id;
    return readRaw(this.id, 0, 0);
  }

  /**
   * Copy what the run has printed into `into`, and its length into the buffer.
   *
   * The same probe-then-fill pair as `readFrame`: `out` is asked for the length,
   * the buffer is checked, then filled. `setLength` is the caller-visible result,
   * so `into.text()` is exactly the bytes the run wrote and no more.
   */
  out(into: OutBuffer): i32 {
    if (!this.isValid()) return this.id;
    const need = outRaw(this.id, 0, 0);
    if (need < 0) return need;
    const have = into.byteLength();
    if (need > have) return -28; // ENOSPC
    const written = outRaw(this.id, <i32>into.address(), have);
    if (written < 0) return written;
    into.length = written;
    return written;
  }

  /** End the run. Idempotent in effect: a second stop is `-EBADF` from the host. */
  stop(): i32 {
    if (!this.isValid()) return this.id;
    return stopRaw(this.id);
  }

  /**
   * The pipeline id a forwarded frame must be submitted under.
   *
   * **Not the id the nested guest used.** Its pipeline owns one texture array and
   * so does the host's pipeline of the same id, and an array has one size — the
   * editor's font pages are 640x500 and an isometric scene's are 128x128, which a
   * shared preset 1 refuses. So the host built the nested guest a pipeline of its
   * own when the run started, and this asks for that id.
   *
   * `-ENOENT` means the run recorded no such pipeline (it never called
   * `set_pipeline`, or the host had no canvas to replay onto).
   */
  pipe(nested: i32): i32 {
    if (!this.isValid()) return this.id;
    return pipeRaw(this.id, nested);
  }
}

/**
 * Start a guest under the host's control: `Dev.run(path, RUN_RENDERING, w, h)`.
 *
 * A class rather than a free `run`, because a bare top-level `run` sits beside
 * `Scene.run` in the same import list and they mean different things — this one
 * starts a *process*, that one drives a *scene*.
 */
export class Dev {
  /**
   * `path` is resolved by the host: absolute as given, otherwise under the
   * directory the host was started in (`host/dev.rs`, `resolve_path`). A
   * relative path is therefore relative to the *process's* working directory,
   * not to anything the guest knows.
   *
   * `width`/`height` are the rectangle the run draws into — the outer guest's
   * viewport. A nested guest reads them back as `platform.surfaceWidth()` /
   * `surfaceHeight()`, which is how it can tell it was given a rectangle to fill
   * rather than a window of its own.
   *
   * Flags must name exactly one kind: `RUN_BATCH` or `RUN_RENDERING`. Anything
   * else is `-EINVAL` rather than a guess, and `RUN_RENDERING` on a module with
   * no `_game_running` is refused before the run takes an id.
   */
  static run(path: string, flags: i32, width: i32, height: i32): DevRun {
    if (path.length == 0) return new DevRun(-22); // EINVAL: no path
    const bytes = String.UTF8.encode(path);
    const id = runRaw(
      <i32>changetype<usize>(bytes),
      bytes.byteLength,
      flags,
      <u32>(width > 0 ? width : 0),
      <u32>(height > 0 ? height : 0),
    );
    return new DevRun(id);
  }
}
