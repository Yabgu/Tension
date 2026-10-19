/**
 * **NOT ENABLED.** This file is not exported from `ogre/index.ts`, and cannot be
 * until the async transform stops skipping library sources:
 * `src/async/lower.ts:263` (`if (source.isLibrary) continue;`) means a function
 * declared in a package reached through `~lib/` is never lowered, and codegen
 * then reports `AS100: the async lowering transform did not run` at its await.
 * Measured: the identical body compiles when declared in user source, and fails
 * here. See `docs/resource-async-scope.md`'s amendment. The synchronous API is
 * unaffected and remains the only shipping path.
 *
 * ---
 *
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

import { rt, CLASS_JOB_DONE, CLASS_JOB_FAILED } from "../runtime/rt";
import {
  jobError,
  jobState,
  queueMeshLoad,
  queueTextureLoad,
  releaseJob
} from "./index";
import { JOB_DONE } from "./wire";

/** The awaited payload word is a `u32`; the protocol is `i32`. The cast lives
 *  outside the async bodies, which refuse `<T>expr`. */
function toI32(value: u32): i32 {
  return <i32>value;
}

/**
 * The shared body: queue, wait, classify, release.
 *
 * Named `loadResource`, not `load`: a top-level `load` shadows the builtin
 * `load<T>` for every module that reaches this one through a barrel, and the
 * result is `TS2315: Type '…/async/load' is not generic` in unrelated files.
 *
 * A negative `job` is the queue's own refusal (0 is not a valid id — job ids
 * are `slot + 1`, `loader.cpp:220`), and it is returned **without parking**: a
 * task parked on an id that was never queued would never complete.
 */
async function loadResource(kind: i32, name: string, priority: i32): i32 {
  rt.start();
  const job: i32 = kind == 0
    ? queueMeshLoad(name, priority)
    : queueTextureLoad(name, priority);
  if (job <= 0) return job;

  // Declared before the park: a local declared after an `await` and read later
  // is scoped to its own resume guard (the transform's documented limit).
  let result: i32 = 0;
  let status: i32 = 0;
  let cls: i32 = 0;
  const awaited: Task<u32> = rt.job(job);
  const payload: u32 = await awaited;
  status = awaited._record.status;
  cls = awaited._record.class_;

  // **The delivered record decides the outcome, not the job slot.** The record
  // arrived through the ring and is authoritative; the slot the guest reads is
  // the arena mirror, which the host publishes on its own schedule. Measured
  // (bouncing-bodies, one run in three): the completion arrived with the right
  // resource id while `jobState` still answered `1` — not yet `JOB_DONE` — so
  // classifying by the slot turned a successful load into -EIO.
  if (status != 0) {
    // §6.4: a dropped completion wakes the task with -EIO. The record's status
    // is the only place a drop is visible, so it is checked first.
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
  releaseJob(job);
  return result;
}

/**
 * Loads a mesh, returning its resource id, or a negative errno.
 *
 * ```ts
 * const id: i32 = await ogre.loadMesh("resources/meshes/cube.mesh", 0);
 * if (id < 0) { /* report id and stop *\/ }
 * ```
 *
 * Parks the calling task until the job completes; the frame loop's
 * `rt.runReady()` is what resumes it.
 */
export async function loadMesh(name: string, priority: i32): i32 {
  return await loadResource(0, name, priority);
}

/** Loads a texture; the same contract as `loadMesh`. */
export async function loadTexture(name: string, priority: i32): i32 {
  return await loadResource(1, name, priority);
}
