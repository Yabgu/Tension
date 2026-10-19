// The async runtime's guest-side facade: what a game's frame loop calls.
//
// `docs/async-await-plan-v2.md` §4.7 (the seam), §6.3 (the tick), §3.3 (the
// job surface). The split the plan pins: **std carries the machine**
// (`~lib/task-rt`), the framework connects it to the session's completion
// stream. This file is that connection — three things, no logic of its own:
//
//   1. **the family bindings** (`start`), so `JOB_DONE` and `JOB_FAILED` — two
//      classes, one await — resolve the same parked task (§3.1);
//   2. **the dispatcher** (`deliver`, `onBatch`, `onEvent`), which decodes the
//      arena's 32-byte records and hands their words to `__taskDeliver`
//      verbatim (§6.1, §6.2). The copy is immediate: the sub-ring is transient,
//      and reading a record at resume time would read someone else's event
//      (review 8.3);
//   3. **the tick** (`runReady`), called from the game's frame loop after
//      `RuntimeSession.wait(...)` returns — never from inside a callback,
//      where the session's reentrancy rules refuse a verb (§1.1, §6.5).
//
// The class is `rt`, not a module of loose functions, so the call sites read as
// the plan writes them (`rt.runReady()`) and the barrel cannot collide with a
// game's own `start` or `deliver`.

import { Task, TaskRecord } from "~lib/task";
import {
  __taskBindFamily,
  __taskDeliver,
  __taskHasRunnable,
  __taskReportDrops,
  __taskTick
} from "~lib/task-rt";
import { EventRecord, TableHeader, TABLE_HEADER_SIZE, EVENT_RECORD_SIZE, Callbacks, CLASS_AI_READY, CLASS_AI_DONE, CLASS_AI_ERROR } from "./wire";
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

  /** The last per-class drop count this guest observed (§6.4), job family. */
  private static lastDropped: i32 = -1;

  /** The AI family's drop total, as last observed (§6.4, 0.6.0b). */
  private static lastDroppedAi: i32 = -1;

  /**
   * The AI family's `dropped` total right now: the sum over its three classes.
   *
   * Per family, not per class, because attribution is per family — a drop is
   * counted per class, never per record, so the runtime cannot say *which*
   * stream lost a signal (`__taskReportDrops`' rule). Summing is the honest
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
   * (the same guard `reportDrops` uses, and for the same measured reason).
   *
   * On a healthy stream this stays 0: coalescing leaves at most one record per
   * session in flight, against a capacity of 16 for a maximum of 4 sessions.
   */
  static aiDropped(): i32 {
    if (!isReady()) return -1;
    return rt.aiDroppedNow();
  }

  /**
   * §6.4, guest side: compares the arena's per-class drop counter against the
   * last value observed, and reports any delta for the job family to the
   * runtime, which wakes the affected tasks with `-EIO`.
   *
   * **Why the framework and not std:** the counter is a wire type
   * (`TableHeader.dropped`, `wire.ts:208`; region 1, class index 4), and std
   * must not learn the arena's layout (§4.7's D9 split). The framework reads it,
   * std owns the wake policy.
   *
   * **Scope in v1:** the job family only. The input and log classes ride the
   * same arena but nothing awaits them; a second awaitable family (resources)
   * generalizes this by reading its own class index. The rollup
   * (`FrameState.droppedEvents`) is deliberately *not* used: it cannot attribute
   * a drop to a family.
   */
  static reportDrops(): void {
    // No session, no arena: a guest that has not opened one (a unit harness, or
    // a game before `RuntimeSession.open`) must not read the region table —
    // measured: an unconditional read faulted with "memory access out of
    // bounds" in `tests/rt-dispatch.mjs`, which runs without a session.
    if (!isReady()) return;
    // Region 1's table is indexed by class; `TableHeader` is 32 bytes and the
    // job class is 4 (`arena.rs:202-213`). The base of the class table is
    // `regionOffset(1)` — see `runtime/wire.ts`'s `TableHeader` for the layout.
    const header = changetype<TableHeader>(ringHeaderOffset(CLASS_JOB_DONE));
    const dropped = header.dropped;
    if (rt.lastDropped < 0) {
      rt.lastDropped = <i32>dropped;   // first tick: adopt, report nothing
      return;
    }
    if (<i32>dropped == rt.lastDropped) return;
    const delta = <i32>dropped - rt.lastDropped;
    rt.lastDropped = <i32>dropped;
    if (delta > 0) __taskReportDrops(FAMILY_JOBS, delta);

    // The AI family (0.6.0b): the same rule, its own counter. A lost stream
    // signal is fatal — the guest would park with nothing coming — so it must
    // wake with a failure status rather than hang.
    const aiNow = rt.aiDroppedNow();
    if (rt.lastDroppedAi < 0) {
      rt.lastDroppedAi = aiNow;        // first tick: adopt, report nothing
      return;
    }
    if (aiNow == rt.lastDroppedAi) return;
    const aiDelta = aiNow - rt.lastDroppedAi;
    rt.lastDroppedAi = aiNow;
    if (aiDelta > 0) __taskReportDrops(FAMILY_AI, aiDelta);
  }

  /**
   * Resumes the ready tasks, in delivery order — one resume per task per tick
   * (§6.5). Call after `RuntimeSession.wait(...)` returns.
   */
  static runReady(): void {
    rt.reportDrops();
    __taskTick();
  }

  /**
   * Decodes `count` contiguous records starting at `ptr` and delivers each
   * (§6.1). The stride is 32 bytes, and a batch may mix several tasks'
   * completions — so the call is per-record, never per-batch.
   */
  static deliver(class_: u32, ptr: u32, count: u32): void {
    for (let i: u32 = 0; i < count; ++i) {
      const record = changetype<EventRecord>(ptr + i * EVENT_RECORD_SIZE);
      __taskDeliver(
        <i32>record.class_,
        <i32>record.a,
        <i32>record.b,
        reinterpret<i32>(record.f0),
        reinterpret<i32>(record.f1)
      );
    }
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
   * A handle for a queued job (§3.3): awaiting it parks on
   * `(JOBS, jobId)`, which is exactly what the loader's completion posts —
   * `post_event(JOB_DONE|JOB_FAILED, job_id, …)` (`loader.cpp:433-439`,
   * `adapter.cpp:194-197`).
   *
   * The record is stamped with the success class's id and the job id; the
   * family lookup is what makes the failure class resolve the same task.
   */
  /**
   * A handle for one signal on an AI stream (0.6.0b): awaiting it parks on
   * `(AI family, session handle)`, which is what the backend posts —
   * `post_event(AI_READY|AI_DONE|AI_ERROR, session, …)`.
   *
   * The record is stamped with `AI_DONE`'s class (the family's key, mirroring
   * `rt.job`'s use of `JOB_DONE`) and the session handle. The delivered class
   * replaces it, so a caller that wants the raw signal can await this and read
   * `_record.class_` / `_record.payload`; callers normally want {@link stream},
   * which classifies.
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
   * Waits for the next signal on `session`'s stream, classified by the
   * **delivered class** — never by the payload.
   *
   * ```
   * while (true) {
   *   const n: i32 = await rt.stream(session);
   *   if (n < 0) break;               // AI_ERROR, or a dropped signal
   *   if (n == 0) break;              // AI_DONE
   *   write(session.read());          // AI_READY: bytes are available
   * }
   * ```
   *
   * Return protocol:
   *
   * | delivered class | returns |
   * |---|---|
   * | `AI_READY` | the unread byte count, always `> 0` |
   * | `AI_DONE` | `0` |
   * | `AI_ERROR` | `-EIO` |
   * | a dropped signal | the status `__taskReportDrops` wrote (`-EIO`) |
   *
   * `0` is unambiguous because READY is only posted when bytes were actually
   * appended (the host's set-if-not-set rule), and the terminal is posted only
   * once the reply is drained — so a `0` never means "the tail is still
   * unread". A zero-length READY cannot exist.
   */
  static stream(session: i32): Task<i32> {
    return streamWait(session);
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

/**
 * The classifying body of `rt.stream`, a free function rather than a method:
 * the async transform lowers this file, and an `async` class member would
 * change `rt`'s shape for every guest that imports the barrel.
 *
 * Locals read after the `await` are declared before it — the transform's
 * documented limit (a local declared after an await is scoped to its own
 * resume guard), the same reason `ogre/async.ts` is shaped this way.
 */
async function streamWait(session: i32): i32 {
  let result: i32 = 0;
  let status: i32 = 0;
  let cls: i32 = 0;
  const awaited: Task<i32> = rt.streamTask(session);
  const payload: i32 = await awaited;
  status = awaited._record.status;
  cls = awaited._record.class_;

  if (status != 0) {
    // A dropped signal: `__taskReportDrops` wakes the task with -EIO and leaves
    // the class as it was. Checked first, because it is the one case the class
    // cannot describe.
    result = status;
  } else if (cls == CLASS_AI_READY) {
    // A count, never 0: the host signals only when it appended. A 0 here is an
    // incoherent record — treat it as the lost completion it is.
    result = payload > 0 ? payload : -5;
  } else if (cls == CLASS_AI_DONE) {
    result = 0;
  } else if (cls == CLASS_AI_ERROR) {
    // The reason is in the reply buffer, where the backend already put it; the
    // class carries the outcome, so no errno vocabulary is needed.
    result = -5; // -EIO
  } else {
    // Not an AI class at all: another family's completion reached this key, or
    // a record nobody stamped. Never report success.
    result = -5;
  }
  return result;
}
