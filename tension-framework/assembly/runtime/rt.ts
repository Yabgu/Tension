// The async runtime's guest-side facade: what a game's frame loop calls.
//
// `docs/async-await-plan-v2.md` §4.7 (the seam), §6.3 (the tick), §3.3 (the
// job surface). The split the plan pins: **std carries the machine**
// (`~lib/task-rt`), the framework connects it to the session's completion
// stream. This file is that connection — three things, no logic of its own:
//
//   1. **the family bindings** (`start`), so `JOB_DONE` and `JOB_FAILED` — two
//      classes, one await — resolve the same parked task (§3.1);
//   2. **the reclaim** (`deliver`, `onBatch`, `onEvent`), which says the guest
//      has consumed a class's records so the sub-ring may reuse the slots
//      (§6.1, §6.2). The *words* no longer travel through here: the host
//      matches each published record to its parked task and wakes it (§2.2),
//      so a guest that never ticks still gets its completion.
//
// There is no tick (0.7.0). `__taskDeliver`, `__taskTick` and
// `__taskReportDrops` — and the drop attribution that called the last of them —
// are gone; the host publishes, matches, wakes and attributes drops itself.
//
// The class is `rt`, not a module of loose functions, so the call sites read as
// the plan writes them (`rt.runReady()`) and the barrel cannot collide with a
// game's own `start` or `deliver`.

import { Task, TaskRecord } from "~lib/task";
import { __taskBindFamily, __taskHasRunnable } from "~lib/task-rt";
import { EventRecord, TableHeader, TABLE_HEADER_SIZE, EVENT_RECORD_SIZE, Callbacks, CLASS_AI_READY, CLASS_AI_DONE, CLASS_AI_ERROR, CLASS_FRAME } from "./wire";
import { effectiveRingCapacities } from "./config";
import { makeCallbacks } from "./callbacks";
import { regionOffset } from "./arena";
import { isReady } from "./index";

/** The EVENT_TABLE region: every class's sub-ring, headers and records. */
const REGION_EVENT_TABLE: u32 = 5;

/**
 * The byte offset of one class's sub-ring header, mirroring the session's own
 * `ring_offset` (`arena.rs:1198-1207`): each class contributes a 32-byte header
 * plus `capacity × 32` bytes of records, in class-id order, from the start of
 * the EVENT_TABLE region.
 */
function ringHeaderOffset(class_: u32): u32 {
  let at = regionOffset(REGION_EVENT_TABLE);
  for (let i: u32 = 0; i < class_; ++i) {
    at += TABLE_HEADER_SIZE + effectiveRingCapacities[i] * EVENT_RECORD_SIZE;
  }
  return at;
}

/** The arena's completion class ids (`arena.rs:202-213`). */
export const CLASS_JOB_FAILED: i32 = 1;
export const CLASS_RESOURCE_READY: i32 = 5;
export const CLASS_JOB_DONE: i32 = 4;
export const CLASS_RESOURCE_FAILED: i32 = 2;

/** One family per awaitable outcome pair (§3.1): the success class's id. */
const FAMILY_JOBS: i32 = CLASS_JOB_DONE;
const FAMILY_RESOURCES: i32 = CLASS_RESOURCE_READY;
/**
 * The AI family (0.6.0a). One family for three classes: a stream's `READY`,
 * `DONE` and `ERROR` all resolve the same parked task, and the **delivered
 * class** — not the payload — decides which it was. Keyed on `AI_DONE`'s id for
 * the same reason `FAMILY_JOBS` is keyed on `JOB_DONE`'s: the success class is
 * the one a caller awaits.
 */
const FAMILY_AI: i32 = CLASS_AI_DONE;

export class rt {
  /**
   * Binds the completion classes to their families (§3.1). Call once, before
   * the first `await` can park — the dispatcher resolves a delivered class
   * through these, and an unbound class is its own family.
   */
  static start(): void {
    __taskBindFamily(CLASS_JOB_DONE, FAMILY_JOBS);
    __taskBindFamily(CLASS_JOB_FAILED, FAMILY_JOBS);
    __taskBindFamily(CLASS_RESOURCE_READY, FAMILY_RESOURCES);
    __taskBindFamily(CLASS_RESOURCE_FAILED, FAMILY_RESOURCES);
    __taskBindFamily(CLASS_AI_READY, FAMILY_AI);
    __taskBindFamily(CLASS_AI_DONE, FAMILY_AI);
    __taskBindFamily(CLASS_AI_ERROR, FAMILY_AI);
  }

  /** Whether a task is ready to resume — the frame loop's `wait(0)` test (§6.3). */
  static hasRunnable(): bool {
    return __taskHasRunnable();
  }

  /**
   * The AI family's `dropped` total right now: the sum over its three classes.
   *
   * Per family, not per class, because attribution is per family — a drop is
   * counted per class, never per record, so the runtime cannot say *which*
   * stream lost a signal (the drop rule). Summing is the honest
   * rollup for the one family those three classes form.
   */
  private static aiDroppedNow(): i32 {
    let total: i32 = 0;
    total += <i32>changetype<TableHeader>(ringHeaderOffset(CLASS_AI_READY)).dropped;
    total += <i32>changetype<TableHeader>(ringHeaderOffset(CLASS_AI_DONE)).dropped;
    total += <i32>changetype<TableHeader>(ringHeaderOffset(CLASS_AI_ERROR)).dropped;
    return total;
  }

  /**
   * The AI family's dropped count, for a test or a diagnostic. `-1` without a
   * session: a guest that has not opened one must not read the region table
   * (the same guard every region-table read in this file uses).
   *
   * On a healthy stream this stays 0: coalescing leaves at most one record per
   * session in flight, against a capacity of 16 for a maximum of 4 sessions.
   */
  static aiDropped(): i32 {
    if (!isReady()) return -1;
    return rt.aiDroppedNow();
  }

  /**
   * Decodes `count` contiguous records and reclaims their slots (§6.1).
   *
   * The words no longer travel through here (0.7.0): the host matches every
   * published record to its parked task and wakes it with `__taskResume`, so
   * this callback's whole job is to say the guest has consumed `[tail, head)`
   * and the sub-ring may reuse those slots. Without that, every class fills its
   * ring and then drops — measured with the real model, a reply stops dead at 16
   * chunks (`AI_READY`'s capacity).
   *
   * `head` cannot move under this: only an epoch flush writes it, and no epoch
   * runs inside a callback (§1.1). Guarded like every other region-table read: a
   * guest with no session must not touch it (measured as "memory access out of
   * bounds" in `tests/rt-dispatch.mjs`).
   */
  static deliver(class_: u32, ptr: u32, count: u32): void {
    if (count == 0) return;
    if (!isReady()) return;
    const header = changetype<TableHeader>(ringHeaderOffset(class_));
    header.tail = header.head;
  }

  /** The `onBatch` handler: `class, first record, count` (§6.1). */
  static onBatch(class_: u32, ptr: u32, count: u32): i32 {
    rt.deliver(class_, ptr, count);
    return 0;
  }

  /** The `onEvent` handler: `class, one record` (§6.1). */
  static onEvent(class_: u32, ptr: u32): i32 {
    rt.deliver(class_, ptr, 1);
    return 0;
  }

  /**
   * The canonical callbacks record: `onBatch` and `onEvent` wired to the
   * dispatcher. A game that needs its own handlers can still build its own
   * record and call `rt.deliver` from them.
   */
  static callbacks(): Callbacks {
    return makeCallbacks(rt.onBatch, rt.onEvent);
  }

  /**
   * A handle for one signal on an AI stream (0.6.0b): awaiting it parks on
   * `(AI family, session handle)`, which is what the backend posts —
   * `post_event(AI_READY|AI_DONE|AI_ERROR, session, …)`.
   *
   * The record is stamped with `AI_DONE`'s class (the family's key, mirroring
   * `rt.job`'s use of `JOB_DONE`) and the session handle. The delivered class
   * replaces it, so a caller that wants the raw signal can await this and read
   * `_record.class_` / `_record.payload`; callers normally want {@link stream}
   * plus {@link classify}.
   */
  static streamTask(session: i32): Task<i32> {
    const record = new TaskRecord();
    record.class_ = CLASS_AI_DONE;
    record.key = session;
    const handle = new Task<i32>();
    handle._record = record;
    return handle;
  }

  /**
   * A handle for the next signal on `session`'s stream. Awaiting it parks the
   * **caller** on `(AI family, session handle)` — no layer between, so a
   * host-owned loop can wake it directly (0.7.0a). Classify the result with
   * {@link classify}, which reads the record after the await.
   *
   * ```
   * const signal: Task<i32> = rt.stream(session);
   * await signal;
   * const n: i32 = rt.classify(signal);
   * ```
   *
   * The handle is exactly `streamTask`'s: the record is stamped with
   * `AI_DONE`'s class (the family's key, mirroring `rt.job`'s use of
   * `JOB_DONE`) and the session handle; the host's delivered class replaces it.
   */
  static stream(session: i32): Task<i32> {
    return rt.streamTask(session);
  }

  /**
   * Classifies a delivered AI signal by its **delivered class** — never by the
   * payload. Synchronous: it reads the record the await filled, and must not
   * park a second task (an `async` wrapper here would reintroduce the
   * two-layer composition `rt.frame` was fixed for).
   *
   * Return protocol:
   *
   * | delivered class | returns |
   * |---|---|
   * | `AI_READY` | the unread byte count, always `> 0` |
   * | `AI_DONE` | `0` |
   * | `AI_ERROR` | `-EIO` |
   * | a dropped signal | the status the host wrote with `__taskFail` (`-EIO`) |
   *
   * `0` is unambiguous because READY is only posted when bytes were actually
   * appended (the host's set-if-not-set rule), and the terminal is posted only
   * once the reply is drained — so a `0` never means "the tail is still
   * unread". A zero-length READY cannot exist.
   */
  static classify(signal: Task<i32>): i32 {
    const status: i32 = signal._record.status;
    const cls: i32 = signal._record.class_;
    const payload: i32 = signal._record.payload;

    if (status != 0) {
      // A dropped signal: `__taskReportDrops` wakes the task with -EIO and
      // leaves the class as it was. Checked first, because it is the one case
      // the class cannot describe.
      return status;
    }
    if (cls == CLASS_AI_READY) {
      // A count, never 0: the host signals only when it appended. A 0 here is
      // an incoherent record — treat it as the lost completion it is.
      return payload > 0 ? payload : -5;
    }
    if (cls == CLASS_AI_DONE) return 0;
    // AI_ERROR: the reason is in the reply buffer, where the backend already
    // put it; the class carries the outcome.
    // Anything else: another family's completion reached this key, or a record
    // nobody stamped. Never report success.
    return -5;
  }

  /**
   * Waits for the next frame (0.7.0a): parks on `(FRAME, 0)`, and the host-owned
   * loop wakes it once per presented frame.
   *
   * The host adds this task's id to its wake batch — no ring entry, no per-frame
   * record. That is what `MODE_POLLED` means for class 9: a 256-slot ring fed at
   * 120 Hz would fill in 2.13 s and count every later frame as a drop, poisoning
   * the signal `-EIO` attribution rests on.
   *
   * A guest that never calls this keeps its own loop: nothing parks on FRAME, so
   * the host's frame add finds nothing and does nothing.
   */
  static frame(): Task<i32> {
    return frameTask(CLASS_FRAME, 0);
  }

  /**
   * A handle for a queued job (§3.3): awaiting it parks on
   * `(JOBS, jobId)`, which is exactly what the loader's completion posts —
   * `post_event(JOB_DONE|JOB_FAILED, job_id, …)` (`loader.cpp:433-439`,
   * `adapter.cpp:194-197`).
   *
   * The record is stamped with the success class's id and the job id; the
   * family lookup is what makes the failure class resolve the same task.
   */
  static job(jobId: i32): Task<u32> {
    const record = new TaskRecord();
    record.class_ = CLASS_JOB_DONE;
    record.key = jobId;
    const handle = new Task<u32>();
    handle._record = record;
    return handle;
  }
}

/** Builds the FRAME handle. A plain function, not an async one: `await
 *  rt.frame()` must park its caller on `(FRAME, 0)` with no layer between. */
function frameTask(class_: u32, key: i32): Task<i32> {
  const record = new TaskRecord();
  record.class_ = <i32>class_;
  record.key = key;
  const handle = new Task<i32>();
  handle._record = record;
  return handle;
}

