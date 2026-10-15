// Frame-loop pause measurement.
//
// The collector runs INLINE inside the allocation that crosses the threshold
// (itcms.ts: `if (total >= threshold) interrupt();`), so timing individual
// allocations is exactly how a frame experiences a pause. This workload times
// every allocation and records both counts and the tail, because a single
// worst-case number is not a distribution and the tail is what breaks frames.
//
// Results are written into a StaticArray<f64> the host reads; see rptr().

class Env { a: i32 = 0; }

@external("env", "now") declare function nowMs(): f64;

const TOPN: i32 = 8;

let R: StaticArray<f64> = new StaticArray<f64>(32);

function rep(i: i32, v: f64): void { unchecked(R[i] = v); }

export function rptr(): usize { return changetype<usize>(R); }

/**
 * `frames` x `perFrame` allocations, with an optional `__collect()` at the
 * frame boundary every `collectEvery` frames (0 = never).
 *
 * Slots:
 *   0  worst single-allocation stall (ms)
 *   1  total time inside those allocations (ms)
 *   2  worst frame-boundary collection (ms)
 *   3  total frame-boundary collection time (ms)
 *   4  number of frame-boundary collections
 *   5  allocations over 16 ms
 *   6  allocations over 8 ms
 *   7  allocations over 4 ms
 *   8  allocations over 1 ms
 *   9  heap pages at the end
 *  10..17  the TOPN worst stalls, descending
 */
export function run(frames: i32, perFrame: i32, collectEvery: i32): void {
  let worstAlloc = 0.0, totalAlloc = 0.0;
  let worstGC = 0.0, totalGC = 0.0, gcCount = 0.0;
  let over16 = 0.0, over8 = 0.0, over4 = 0.0, over1 = 0.0;
  let top: StaticArray<f64> = new StaticArray<f64>(TOPN);

  let live: Env[] = new Array<Env>(256);
  let li = 0;

  for (let f = 0; f < frames; f++) {
    for (let i = 0; i < perFrame; i++) {
      const t0 = nowMs();
      const e = new Env();
      e.a = f + i;
      const t1 = nowMs();
      const dt = t1 - t0;

      totalAlloc += dt;
      if (dt > worstAlloc) worstAlloc = dt;
      if (dt > 16.0) over16++;
      else if (dt > 8.0) over8++;
      else if (dt > 4.0) over4++;
      else if (dt > 1.0) over1++;

      // insertion into the top-N, descending
      if (dt > unchecked(top[TOPN - 1])) {
        let j = TOPN - 1;
        while (j > 0 && unchecked(top[j - 1]) < dt) {
          unchecked(top[j] = unchecked(top[j - 1]));
          j--;
        }
        unchecked(top[j] = dt);
      }

      unchecked(live[li] = e);
      if (++li == 256) li = 0;
    }

    if (collectEvery > 0 && (f % collectEvery) == 0) {
      const g0 = nowMs();
      __collect();
      const g1 = nowMs();
      const dt = g1 - g0;
      totalGC += dt; gcCount++;
      if (dt > worstGC) worstGC = dt;
    }
  }

  rep(0, worstAlloc); rep(1, totalAlloc);
  rep(2, worstGC);    rep(3, totalGC); rep(4, gcCount);
  rep(5, over16);     rep(6, over8);   rep(7, over4); rep(8, over1);
  rep(9, <f64>memory.size());
  for (let i = 0; i < TOPN; i++) rep(10 + i, unchecked(top[i]));
}
