// tension-framework/assembly/time.ts — a clock the guest owns.
//
// ## There is no host clock, and that is a decision
//
// The runtime never hands a guest "the time". `RuntimeSession.wait(ms)` blocks
// for a timeout and reports deliveries; nothing else measures anything. So a
// guest that wants a `dt` computes it, and this class is the one place that
// arithmetic lives.
//
// The frame step is **fixed**, not measured: `DELTA` is exactly `1/60` and
// `now()` is `frames / 60`. That looks like a limitation until you follow it
// through — a guest whose time is a function of its own frame count, and whose
// only inputs are the ones it asks for, is a **pure function of its inputs**.
// The same program with the same argument list produces the same frames, which is
// what makes the docs engine's recorded examples possible (`apps/docs` runs each
// `runnable` block once at build time and ships its stdout) and what makes a
// replay of a bug a reproduction rather than a coincidence.
//
// The cost is real and worth stating: a game that falls behind does not speed up,
// because nothing tells it that it fell behind. Physics is the case that cares —
// `physics.World.step(dt)` takes the frame's `dt` and derives its own sub-steps,
// so a game that wants *simulated* time to track *wall* time must ask the wall
// clock itself, which means a verb this runtime does not have. Nothing here
// pretends otherwise: `Time.deltaTime()` answers the fixed step, and a caller
// that wants something else is asking a question this class does not answer.
//
// ## What advances it
//
// `Time.tick()` — called by `Scene.run` once per frame, and by nothing else. A
// guest that owns its own loop (the pre-adoption shape, and still the shape
// `examples/2d/isometric` uses as the raw oracle) calls `tick` itself or does its
// own arithmetic. A guest that never ticks reads `now() == 0` for ever, which is
// honest: it has not presented a frame, so it has not spent any time.

/** The fixed step, in seconds. 60 Hz, and the guest's choice rather than a host's. */
const DELTA: f32 = 1.0 / 60.0;

/** Frames presented, the guest's only notion of elapsed time. */
let frames: i64 = 0;

/**
 * The guest's clock: seconds since `Time.reset()`, counted in frames.
 *
 * Everything here is `f32` because that is what a game multiplies a velocity by.
 * `frames` is an `i64` so a run lasting days does not wrap — at 60 Hz an `i32`
 * frame counter overflows in 414 days, which is not a bug anyone would find, and
 * an `i64` costs nothing to keep correct.
 */
export class Time {
  /** The step one frame advances, in seconds: exactly `1/60`. */
  static deltaTime(): f32 {
    return DELTA;
  }

  /** Seconds since the clock started, from the frame count: `frames / 60`. */
  static now(): f32 {
    return <f32>frames * DELTA;
  }

  /** Frames presented since the clock started. */
  static frameCount(): i64 {
    return frames;
  }

  /**
   * Advance one frame. Called by the loop, once per presented frame.
   *
   * Public because a guest with its own loop has to call it: a clock that only
   * the framework could advance would be a clock a hand-written loop cannot use,
   * and the manual-loop examples are staying.
   */
  static tick(): void {
    frames++;
  }

  /** Back to zero — for a restart, or for a fixture that asserts on `now()`. */
  static reset(): void {
    frames = 0;
  }
}
