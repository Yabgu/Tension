/**
 * Awaitable resource loading: `await ogre.loadMesh(path, 0)`.
 *
 * The synchronous API is unchanged and remains the primitive: `queueMeshLoad`
 * returns a job id, `jobState`/`jobError` read its slot, and `releaseJob` frees
 * it. This module composes those with `rt.job`, so a caller that wants to wait
 * no longer has to poll.
 *
 * **The error protocol is the capability's own.** A positive return is the
 * resource id; a negative return is the errno, unchanged from `jobError`,
 * `ogre.init`, `mountTns` and `queueMeshLoad`. Nothing throws — AS has no
 * `try`/`catch` — so a caller checks `id < 0` and reads the code from `id`.
 * There is deliberately no companion "last error" reader: it would be
 * module-level mutable state shared by every concurrent load, and every other
 * accessor in the framework takes the id it applies to.
 *
 * **Where the failure is read from.** Not from `TaskRecord.status` — the runtime
 * leaves that 0 for job completions and derives it only for the drop case
 * (`docs/async-await-plan-v2.md` §3.4 is unimplemented on the dispatcher side;
 * filed separately). The authoritative errno is the loader's own slot, which
 * `jobError` reads (`loader.cpp:498`, `:715`). The awaited payload word is the
 * resource id on success and the errno *as a u32* on failure, so it is never
 * returned raw: a failed load would otherwise look like resource 4294967294.
 *
 * **Why `rt.start()` is called here.** Awaiting a job parks on the success
 * class; a `JOB_FAILED` completion only resolves that task if the two classes
 * are bound to one family. Without the binding a successful load resumes and a
 * failed one parks forever — measured, and no OGRE example called `start()`
 * before this module existed. `start()` is idempotent (it sets entries in a
 * map), so calling it per load is safe; `init` calls it too, which covers the
 * guest that only ever uses the synchronous API.
 *
 * Two constraints the compiler imposes on this file, both measured, both why
 * the body is shaped the way it is:
 *
 * - **No default parameters** in an async function (`AS100: optional or rest
 *   parameters in an async function`), so `priority` is required.
 * - **No `<T>expr` cast and no local declared after an `await`** in an async
 *   body, so the `u32`→`i32` reinterpretation lives in `toI32` and every local
 *   read after the park is declared before it.
 */

import { Task, TaskRecord } from "~lib/task";
import { rt, CLASS_JOB_DONE, CLASS_JOB_FAILED } from "../runtime/rt";
import {
  jobError,
  queueMeshLoad,
  queueTextureLoad,
  releaseJob
} from "./index";

/** Reads the payload word as the `i32` protocol value. The bits are the same;
 *  the cast lives outside any async body, which refuses `<T>expr`. */
function toI32(value: i32): i32 {
  return value;
}

/** A handle that is already settled: awaiting it does not park, and the
 *  transform's settled check falls straight through to the payload. */
function settled(errno: i32): Task<u32> {
  const record = new TaskRecord();
  record.status = errno;
  record.done = 1;
  const handle = new Task<u32>();
  handle._record = record;
  return handle;
}

/**
 * Queues the load and returns the handle to await.
 *
 * A negative `job` is the queue's own refusal (0 is not a valid id — job ids
 * are `slot + 1`, `loader.cpp:220`), and it comes back as an already-settled
 * handle **without parking**: a task parked on an id that was never queued
 * would never complete. The refusal is carried in `status`, which is exactly
 * what {@link loadResult} returns first.
 */
function loadHandle(kind: i32, name: string, priority: i32): Task<u32> {
  rt.start();
  const job: i32 = kind == 0
    ? queueMeshLoad(name, priority)
    : queueTextureLoad(name, priority);
  if (job <= 0) return settled(job);
  return rt.job(job);
}

/**
 * Loads a mesh: returns the handle to await, then classify with
 * {@link loadResult}.
 *
 * ```ts
 * const load: Task<u32> = ogre.loadMesh("resources/meshes/cube.mesh", 0);
 * await load;
 * const id: i32 = ogre.loadResult(load);
 * if (id < 0) { /* report id and stop *\/ }
 * ```
 *
 * The handle is the job's own record, so `await` parks the **calling** task on
 * `(JOBS, job)` — the completion the loader posts. Nothing is composed above it.
 */
export function loadMesh(name: string, priority: i32): Task<u32> {
  return loadHandle(0, name, priority);
}

/** Loads a texture; the same contract as `loadMesh`. */
export function loadTexture(name: string, priority: i32): Task<u32> {
  return loadHandle(1, name, priority);
}

/**
 * The outcome of a load, read from the record the await filled, and the job
 * released. Synchronous by design: classification must not park a second task.
 *
 * **The delivered record decides the outcome, not the job slot.** The record
 * arrived through the ring and is authoritative; the slot the guest reads is
 * the arena mirror, which the host publishes on its own schedule. Measured
 * (bouncing-bodies, one run in three): the completion arrived with the right
 * resource id while `jobState` still answered `1` — not yet `JOB_DONE` — so
 * classifying by the slot turned a successful load into -EIO.
 *
 * A positive return is the resource id; a negative return is the errno,
 * unchanged from `jobError` and `queueMeshLoad`.
 */
export function loadResult(signal: Task<u32>): i32 {
  const record = signal._record;
  const status: i32 = record.status;
  const cls: i32 = record.class_;
  const payload: i32 = record.payload;
  const job: i32 = record.key;

  let result: i32 = 0;
  if (status != 0) {
    // §6.4: a dropped completion wakes the task with -EIO, and the queue's own
    // refusal is parked here too. The record's status is the only place either
    // is visible, so it is checked first.
    result = status;
  } else if (cls == CLASS_JOB_DONE) {
    result = toI32(payload);
    // A success record with no resource is incoherent — ids start at 1 — and is
    // the other face of a lost completion.
    if (result == 0) result = -5; // -EIO
  } else if (cls == CLASS_JOB_FAILED) {
    // The failure record's payload *is* the errno, as a u32 (`loader.cpp:434`).
    result = toI32(payload);
    if (result >= 0) { // a malformed failure record: fall back to the slot
      result = jobError(job);
      if (result >= 0) result = -5;
    }
  } else {
    // Not a job class at all: the slot is all there is. Its `error` field is
    // written by the loader (`loader.cpp:498`, `:715`), unlike the task
    // record's `status`, which the runtime leaves 0 for job completions.
    result = jobError(job);
    if (result == 0) result = -5;
  }
  if (job > 0) releaseJob(job);
  return result;
}
