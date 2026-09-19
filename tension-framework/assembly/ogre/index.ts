// The OGRE capability's guest SDK: the seven verbs a guest may call, and the
// two conveniences that make them usable (a config builder and a last-error
// reader).
//
// The split this module lives in (`DESIGN.md` §2, §7): the adapter owns the
// renderer, the session owns delivery, and the guest owns the world. Nothing
// here draws anything — `queueMeshLoad` asks for a resource and returns an id;
// the adapter's `publish` hook is what fills the arena's regions, and
// `RuntimeSession.wait` is what tells the guest that something happened.
//
// **Why the error and job readers exist.** The session's contract is
// errno-first: a negative return is the refusal, and the detail is a string the
// guest fetches. That is right for a host and hostile for a game author, so the
// wrappers below return the errno unchanged and *also* give the two readers a
// game actually wants: `jobState`/`jobResult` (the Job table is in the arena,
// so this is a read, not a verb) and `lastError` (a probe/consume pair, like
// `read_line`).

import { TlvArgmap } from "../runtime/tlv";
import { Job, JOB_SIZE } from "./wire";
import { REGION_JOB } from "../runtime/wire";
import { regionOffset, regionSize } from "../runtime/arena";
import { writeString, lastWriteLength, lastWriteOffset } from "../runtime/strings";

export * from "./wire";

/** `ogre::init(cfg)`: 0, or the errno the adapter refused with. */
@external("ogre", "init")
declare function initRaw(cfgPtr: u32, cfgLen: u32): i32;
/** `ogre::shutdown()`: idempotent. */
@external("ogre", "shutdown")
declare function shutdownRaw(): i32;
/** Queue a mesh load; returns a job id (> 0) or an errno. */
@external("ogre", "queue_mesh_load")
declare function queueMeshLoadRaw(namePtr: u32, nameLen: u32, priority: i32): i32;
/** Queue a texture load; returns a job id (> 0) or an errno. */
@external("ogre", "queue_texture_load")
declare function queueTextureLoadRaw(namePtr: u32, nameLen: u32, priority: i32): i32;
/** Copy a `Job` record into `out_ptr`; 0, or -ENOENT for an unknown id. */
@external("ogre", "job_state")
declare function jobStateRaw(jobId: i32, outPtr: u32): i32;
/** Free a job's slot; 0, or -ENOENT. */
@external("ogre", "job_release")
declare function jobReleaseRaw(jobId: i32): i32;
/** Probe/consume the last error string: `-1` when there is none. */
@external("ogre", "last_error")
declare function lastErrorRaw(ptr: u32, cap: i32): i32;

/** The `ogre_init` config's keys. `abi_version` is first, as every argmap in
 * this runtime requires; the rest are this capability's own. */
export const KEY_ABI_VERSION: u32 = 1;
export const KEY_RENDERER: u32 = 2;
export const KEY_HEADLESS: u32 = 3;
export const KEY_VSYNC: u32 = 4;
export const KEY_FRAME_HZ: u32 = 5;
export const KEY_WINDOW_WIDTH: u32 = 6;
export const KEY_WINDOW_HEIGHT: u32 = 7;

/** Renderer names `renderer` accepts, as the design fixed them (§0). */
export enum Renderer {
  /** The headless renderer: no window, no GPU. What chunk 1's stub acts like. */
  Null = 0,
  Gl3Plus = 1,
  Metal = 2,
  Vulkan = 3,
}

/** Builds the `ogre_init` config over the session runtime's argmap encoder. */
export class ConfigBuilder {
  private argmap: TlvArgmap;

  constructor(abiVersion: u32 = 1) {
    this.argmap = new TlvArgmap(KEY_ABI_VERSION, abiVersion);
  }

  renderer(which: Renderer): ConfigBuilder {
    this.argmap.put(KEY_RENDERER, <u32>which);
    return this;
  }

  headless(on: bool = true): ConfigBuilder {
    this.argmap.put(KEY_HEADLESS, on ? 1 : 0);
    return this;
  }

  vsync(on: bool = true): ConfigBuilder {
    this.argmap.put(KEY_VSYNC, on ? 1 : 0);
    return this;
  }

  frameHz(hz: u32): ConfigBuilder {
    this.argmap.put(KEY_FRAME_HZ, hz);
    return this;
  }

  windowSize(width: u32, height: u32): ConfigBuilder {
    this.argmap.put(KEY_WINDOW_WIDTH, width);
    this.argmap.put(KEY_WINDOW_HEIGHT, height);
    return this;
  }

  /** A headless config at the design's defaults: no window, no vsync. */
  static headless(): ConfigBuilder {
    return new ConfigBuilder().renderer(Renderer.Null).headless(true).vsync(false);
  }

  toBytes(): ArrayBuffer {
    return this.argmap.toBytes();
  }
}

/** Initialize the adapter. */
export function init(cfg: ConfigBuilder): i32 {
  const bytes = cfg.toBytes();
  return initRaw(changetype<usize>(bytes) as u32, <u32>bytes.byteLength);
}

/** Shut the adapter down. Idempotent; the guest's last adapter call. */
export function shutdown(): i32 {
  return shutdownRaw();
}

/** Where job `jobId`'s record lives in the `JOB` region. */
function jobRecord(jobId: i32): Job {
  return changetype<Job>(regionOffset(REGION_JOB) + <u32>(jobId - 1) * JOB_SIZE);
}

/** Whether `jobId` names a slot inside the `JOB` region. */
function jobInRange(jobId: i32): bool {
  if (jobId <= 0) return false;
  return <u32>(jobId - 1) * JOB_SIZE + JOB_SIZE <= regionSize(REGION_JOB);
}

/**
 * Queue a mesh load and return the job id (> 0) or the errno.
 *
 * The path is copied from the `STRING` region, so it must still be there when
 * this returns — which it is: the call is synchronous, and the adapter reads
 * the bytes during it.
 */
export function queueMeshLoad(path: string, priority: i32 = 0): i32 {
  const at = writeString(path);
  if (at == 0 && path.length > 0) return -28; // -ENOSPC: the half is full
  return queueMeshLoadRaw(at, lastWriteLength, priority);
}

/** Queue a texture load; the same contract as `queueMeshLoad`. */
export function queueTextureLoad(path: string, priority: i32 = 0): i32 {
  const at = writeString(path);
  if (at == 0 && path.length > 0) return -28;
  return queueTextureLoadRaw(at, lastWriteLength, priority);
}

/** A job's state (`JOB_*`), or `JOB_FAILED` for an id outside the table. */
export function jobState(jobId: i32): u32 {
  if (!jobInRange(jobId)) return JOB_FAILED;
  return jobRecord(jobId).state;
}

/** A job's resource id once it has one, else 0. */
export function jobResult(jobId: i32): u32 {
  if (!jobInRange(jobId)) return 0;
  return jobRecord(jobId).resourceId;
}

/** A job's error, or 0. */
export function jobError(jobId: i32): i32 {
  if (!jobInRange(jobId)) return -2;
  return jobRecord(jobId).error;
}

/** Free a job's slot. Terminal jobs are not freed automatically: the guest
 * releases them, which is what keeps the table from filling with history. */
export function releaseJob(jobId: i32): i32 {
  return jobReleaseRaw(jobId);
}

/** A job's whole record, for a caller that wants more than state and result. */
export function jobRecordOf(jobId: i32): Job | null {
  if (!jobInRange(jobId)) return null;
  return jobRecord(jobId);
}

/** The `JOB` table's capacity, in jobs. */
export function jobCapacity(): u32 {
  return regionSize(REGION_JOB) / JOB_SIZE;
}

/**
 * The adapter's last error, as a string, or `null` when there is none.
 *
 * Probe/consume, the way `tension::io read_line` is: a `cap <= 0` call asks for
 * the length without consuming, and a `cap > 0` call takes the message. A
 * `null` return means the adapter has nothing to report — which is the normal
 * case, not an error.
 */
export function lastError(): string | null {
  const length = lastErrorRaw(0, 0);
  if (length <= 0) return null;
  const bytes = new ArrayBuffer(length);
  const taken = lastErrorRaw(changetype<usize>(bytes) as u32, length);
  if (taken <= 0) return null;
  return String.UTF8.decodeUnsafe(changetype<usize>(bytes), <usize>taken, false);
}
