// The OGRE capability's guest SDK: the nine verbs a guest may call, and the
// conveniences that make them usable (a config builder, a last-error reader,
// and the record writers the submission verbs address).
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
import {
  SceneNode,
  CameraRecord,
  LightRecord,
  Material,
  Renderable,
  Job,
  JOB_SIZE,
  SCENE_NODE_SIZE,
  SCENE_CAMERA_BASE,
  SCENE_CAMERA_SIZE,
  SCENE_CAMERA_COUNT,
  SCENE_LIGHT_BASE,
  SCENE_LIGHT_SIZE,
  SCENE_LIGHT_COUNT,
  SCENE_NODE_COUNT,
  SCENE_TABLE_BYTES,
  MATERIAL_SIZE,
  MATERIAL_COUNT,
  RENDERABLE_SIZE,
  RENDERABLE_COUNT,
} from "./wire";
import { REGION_JOB, REGION_SCENE, REGION_MATERIAL, REGION_RENDERABLE } from "../runtime/wire";
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
/** `ogre::submit(kind, id, op)`: the record is already in its region slot. */
@external("ogre", "submit")
declare function submitRaw(kind: i32, id: i32, op: i32): i32;
/** Probe/consume the last downloaded frame, and ask for the next one. */
@external("ogre", "screenshot")
declare function screenshotRaw(ptr: u32, cap: i32): i32;

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

// --- submission -------------------------------------------------------------
//
// A submit is two steps, and the order is the point: the record goes into its
// region slot first, then the verb names *which* slot changed. The adapter
// copies the record out of the region during the call, decodes it, and hands
// it to the mirror the render thread applies from. Nothing is drawn here, and
// nothing is drawn until the next applied frame.

/** The five record kinds, as `submit`'s first argument. */
export const SUBMIT_NODE: i32 = 0;
export const SUBMIT_CAMERA: i32 = 1;
export const SUBMIT_LIGHT: i32 = 2;
export const SUBMIT_MATERIAL: i32 = 3;
export const SUBMIT_RENDERABLE: i32 = 4;

/** The two operations. */
export const SUBMIT_UPSERT: i32 = 0;
export const SUBMIT_REMOVE: i32 = 1;

/** Where record `id` of a table lives: region + table base + (id - 1) * size. */
function recordSlot(regionKind: u32, tableBase: u32, id: u32, size: u32): usize {
  return regionOffset(regionKind) + tableBase + (id - 1) * size;
}

/** Copy `bytes` of a record into its slot. The caller has bounds-checked. */
function placeRecord(at: usize, record: usize, bytes: u32): void {
  memory.copy(at, record, bytes);
}

/**
 * Submit a scene node. Nodes carry cameras and lights; 3b's renderables place
 * themselves, and a `parentId` other than 0 is refused by the adapter.
 */
export function submitNode(record: SceneNode): i32 {
  const id = record.nodeId;
  if (id == 0 || id > SCENE_NODE_COUNT) return -22; // -EINVAL
  placeRecord(recordSlot(REGION_SCENE, 0, id, SCENE_NODE_SIZE), changetype<usize>(record),
              SCENE_NODE_SIZE);
  return submitRaw(SUBMIT_NODE, <i32>id, SUBMIT_UPSERT);
}

/** Submit a camera. The first live camera is the one the window renders through. */
export function submitCamera(record: CameraRecord): i32 {
  const id = record.cameraId;
  if (id == 0 || id > SCENE_CAMERA_COUNT) return -22;
  placeRecord(recordSlot(REGION_SCENE, SCENE_CAMERA_BASE, id, SCENE_CAMERA_SIZE),
              changetype<usize>(record), SCENE_CAMERA_SIZE);
  return submitRaw(SUBMIT_CAMERA, <i32>id, SUBMIT_UPSERT);
}

/** Submit a light. */
export function submitLight(record: LightRecord): i32 {
  const id = record.lightId;
  if (id == 0 || id > SCENE_LIGHT_COUNT) return -22;
  placeRecord(recordSlot(REGION_SCENE, SCENE_LIGHT_BASE, id, SCENE_LIGHT_SIZE),
              changetype<usize>(record), SCENE_LIGHT_SIZE);
  return submitRaw(SUBMIT_LIGHT, <i32>id, SUBMIT_UPSERT);
}

/** Submit a material. Its texture slots name resource ids, not paths. */
export function submitMaterial(record: Material): i32 {
  const id = record.materialId;
  if (id == 0 || id > MATERIAL_COUNT) return -22;
  placeRecord(recordSlot(REGION_MATERIAL, 0, id, MATERIAL_SIZE), changetype<usize>(record),
              MATERIAL_SIZE);
  return submitRaw(SUBMIT_MATERIAL, <i32>id, SUBMIT_UPSERT);
}

/** Submit a renderable: a mesh, a material, and an inline transform. */
export function submitRenderable(record: Renderable): i32 {
  const id = record.renderableId;
  if (id == 0 || id > RENDERABLE_COUNT) return -22;
  placeRecord(recordSlot(REGION_RENDERABLE, 0, id, RENDERABLE_SIZE),
              changetype<usize>(record), RENDERABLE_SIZE);
  return submitRaw(SUBMIT_RENDERABLE, <i32>id, SUBMIT_UPSERT);
}

/** Withdraw a node. The adapter destroys its OGRE object on the next frame. */
export function removeNode(id: u32): i32 {
  return submitRaw(SUBMIT_NODE, <i32>id, SUBMIT_REMOVE);
}

/** Withdraw a camera. */
export function removeCamera(id: u32): i32 {
  return submitRaw(SUBMIT_CAMERA, <i32>id, SUBMIT_REMOVE);
}

/** Withdraw a light. */
export function removeLight(id: u32): i32 {
  return submitRaw(SUBMIT_LIGHT, <i32>id, SUBMIT_REMOVE);
}

/** Withdraw a material. A live renderable that binds it refuses this with
 * `-EBUSY`, which is how the adapter keeps a datablock from dying under an
 * item. */
export function removeMaterial(id: u32): i32 {
  return submitRaw(SUBMIT_MATERIAL, <i32>id, SUBMIT_REMOVE);
}

/** Withdraw a renderable. */
export function removeRenderable(id: u32): i32 {
  return submitRaw(SUBMIT_RENDERABLE, <i32>id, SUBMIT_REMOVE);
}

/**
 * Request the next frame's pixels, and read the last frame's — probe/consume,
 * the way `lastError` works: `cap <= 0` asks the byte count without copying,
 * `cap > 0` copies `min(cap, length)` into `bufPtr`. `-1` means no frame has
 * been downloaded yet. RGBA8, top-left origin, at the window's resolution.
 */
export function screenshot(bufPtr: usize, cap: i32): i32 {
  return screenshotRaw(<u32>bufPtr, cap);
}

/**
 * Whether the arena's submission regions are big enough for the tables this
 * SDK addresses. Checked against the *region sizes the layout reports*, so a
 * layout that grew them passes and one that shrank them does not.
 */
export function checkSubmissionRegions(): bool {
  return (
    regionSize(REGION_SCENE) >= SCENE_TABLE_BYTES &&
    regionSize(REGION_MATERIAL) >= MATERIAL_COUNT * MATERIAL_SIZE &&
    regionSize(REGION_RENDERABLE) >= RENDERABLE_COUNT * RENDERABLE_SIZE
  );
}

/** `checkSubmissionRegions`, as an assertion that names what is short. */
export function assertSubmissionRegions(): void {
  assert(
    checkSubmissionRegions(),
    "the arena's submission regions are smaller than the tables this SDK addresses",
  );
}
