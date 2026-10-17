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
  __taskTick
} from "~lib/task-rt";
import { EventRecord } from "./wire";
import { makeCallbacks } from "./callbacks";
import { Callbacks } from "./wire";

/** The arena's completion class ids (`arena.rs:202-213`). */
const CLASS_JOB_FAILED: i32 = 1;
const CLASS_RESOURCE_READY: i32 = 5;
const CLASS_JOB_DONE: i32 = 4;
const CLASS_RESOURCE_FAILED: i32 = 2;

/** One family per awaitable outcome pair (§3.1): the success class's id. */
const FAMILY_JOBS: i32 = CLASS_JOB_DONE;
const FAMILY_RESOURCES: i32 = CLASS_RESOURCE_READY;

/** One event record's size on the wire (`arena.rs:124`). */
const EVENT_RECORD_SIZE: u32 = 32;

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
  }

  /** Whether a task is ready to resume — the frame loop's `wait(0)` test (§6.3). */
  static hasRunnable(): bool {
    return __taskHasRunnable();
  }

  /**
   * Resumes the ready tasks, in delivery order — one resume per task per tick
   * (§6.5). Call after `RuntimeSession.wait(...)` returns.
   */
  static runReady(): void {
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
  static job(jobId: i32): Task<u32> {
    const record = new TaskRecord();
    record.class_ = CLASS_JOB_DONE;
    record.key = jobId;
    const handle = new Task<u32>();
    handle._record = record;
    return handle;
  }
}
