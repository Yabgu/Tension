// Measurement harness: stub vs incremental, for the runtime migration plan.
//
// IMPORTANT HONESTY NOTE, read before quoting any number from this file:
// TensionScript does not have closures yet, and async is not implemented. These
// workloads therefore allocate MANAGED OBJECTS OF THE SHAPE the two plans
// specify (a small managed class with one or two i32/object fields, as an
// environment or a state struct will be) rather than real closures. What is
// being measured is the ALLOCATOR AND COLLECTOR BEHAVIOUR under that
// allocation shape. That is the question the migration turns on -- whether
// `stub` reclaims and what `incremental` costs -- and it is measurable now.
//
// Compiled twice with --runtime stub / --runtime incremental and run in two
// engines. Pure guest-level facts (heap, reclamation, grow events) are engine-
// independent; wall-clock pause is not.

// A host clock, provided by the runner. Returns milliseconds as f64.
@external("env", "now")
declare function nowMs(): f64;

// ── reporting: results land in a static array; the host reads them ───────────

const MAX_RESULTS: i32 = 128;
let results: StaticArray<f64> = new StaticArray<f64>(MAX_RESULTS);
let nResults: i32 = 0;

function report(v: f64): void {
  if (nResults < MAX_RESULTS) {
    unchecked(results[nResults] = v);
    nResults++;
  }
}

export function resultPtr(): usize { return changetype<usize>(results); }
export function resultLen(): i32 { return nResults; }
export function resetResults(): void { nResults = 0; }

// ── the object shapes ────────────────────────────────────────────────────────

/** The shape of a closure environment: one captured mutable i32. */
class Env1 { a: i32 = 0; }

/** The shape of an async state struct: resume point + status + one env ref. */
class State1 {
  resumePoint: u32 = 0;
  status: i32 = 0;
  env: Env1 | null = null;
}

/** A frame-loop workload that creates `perFrame` environments per frame. */
function framesOfEnvs(frames: i32, perFrame: i32, keep: bool): void {
  let sink: Env1[] = new Array<Env1>(keep ? perFrame : 0);
  for (let f = 0; f < frames; f++) {
    for (let i = 0; i < perFrame; i++) {
      const e = new Env1();
      e.a = f + i;
      if (keep) unchecked(sink[i] = e);
    }
  }
  // touch the sink so the loop is not optimised away
  if (keep && sink.length > 0) report(<f64>sink[0].a);
}

// ── M1: 1,000 environments created and used once ─────────────────────────────

export function m1_thousand(): void {
  const pages0 = memory.size();
  let acc = 0;
  for (let i = 0; i < 1000; i++) {
    const e = new Env1();
    e.a = i;
    acc += e.a;
  }
  const pages1 = memory.size();
  report(<f64>(pages1 - pages0) * 65536.0);  // heap grown (bytes)
  report(<f64>acc);                           // 499500 = used, not elided
  report(<f64>pages1 * 65536.0);              // total heap after
}

// ── M2: 100,000 environments over 10 s of simulated frames (600 frames) ──────

export function m2_100k_10s(): void {
  const pages0 = memory.size();
  framesOfEnvs(600, 167, false);
  const pages1 = memory.size();
  report(<f64>(pages1 - pages0) * 65536.0);
  report(<f64>pages1 * 65536.0);
}

// ── M3: 1,000,000 environments over 100 s (6000 frames) ─────────────────────

export function m3_1m_100s(): void {
  const pages0 = memory.size();
  framesOfEnvs(6000, 167, false);
  const pages1 = memory.size();
  report(<f64>(pages1 - pages0) * 65536.0);
  report(<f64>pages1 * 65536.0);
}

// ── M4: array.map with a fresh environment per call, 10,000 frames ───────────

function mapOnce(n: i32): i32 {
  // A non-capturing lambda is what `map` gets; the environment it returns is
  // the shape a CAPTURING one would allocate, once per call.
  let env = new Env1();
  env.a = n;
  const arr = new Array<i32>(n);
  for (let i = 0; i < n; i++) unchecked(arr[i] = i);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += unchecked(arr[i]) + env.a - env.a;
  return sum;
}

export function m4_map_10k_frames(): void {
  const pages0 = memory.size();
  let acc = 0;
  for (let f = 0; f < 10000; f++) acc += mapOnce(16);
  const pages1 = memory.size();
  report(<f64>(pages1 - pages0) * 65536.0);
  report(<f64>pages1 * 65536.0);
  report(<f64>acc);
}

// ── M5: GC pause over a 60 s frame loop ─────────────────────────────────────
//
// The collector runs INLINE inside the allocation that crosses the threshold
// (itcms.ts: `if (total >= threshold) interrupt();`). So timing individual
// allocations is exactly how the frame loop experiences the pause.

export function m5_pause_60s(): void {
  // 60 s at 60 fps = 3600 frames, 100 envs/frame = 360k allocations.
  const samples = 3600 * 100;
  let worst: f64 = 0.0;
  let total: f64 = 0.0;
  let over16: i32 = 0;
  let over4: i32 = 0;
  let over1: i32 = 0;
  let sink: Env1[] = new Array<Env1>(100);
  for (let i = 0; i < samples; i++) {
    const t0 = nowMs();
    const e = new Env1();
    e.a = i;
    const t1 = nowMs();
    const dt = t1 - t0;
    total += dt;
    if (dt > worst) worst = dt;
    if (dt > 16.0) over16++;
    else if (dt > 4.0) over4++;
    else if (dt > 1.0) over1++;
    unchecked(sink[i % 100] = e);
  }
  report(worst);              // max single-allocation wall time (ms)
  report(total);              // total time in those allocations (ms)
  report(<f64>over16);        // count exceeding a 16 ms frame budget
  report(<f64>over4);
  report(<f64>over1);
  report(<f64>samples);
}

/** Cost of one full, forced collection -- the worst case a frame can meet. */
export function m5b_full_collect(): void {
  // build garbage first
  framesOfEnvs(200, 100, false);
  const t0 = nowMs();
  __collect();
  const t1 = nowMs();
  report(t1 - t0);            // full GC wall time (ms)
  report(<f64>memory.size() * 65536.0);
}

// ── M6: 10,000 suspended async tasks ───────────────────────────────────────
//
// A task table holding live state structs, each rooting one environment --
// the exact retention shape async + closures will have (closures plan section
// 0.4 / 7.3). The table is a managed global, so the collector traces it.

class TaskTable {
  items: State1[] = new Array<State1>(0);
  push(s: State1): void { this.items.push(s); }
}
let taskTable: TaskTable = new TaskTable();

export function m6_10k_suspended(): void {
  const pages0 = memory.size();
  for (let i = 0; i < 10000; i++) {
    const env = new Env1();
    env.a = i;
    const st = new State1();
    st.resumePoint = 3;
    st.env = env;
    taskTable.push(st);
  }
  const pages1 = memory.size();
  report(<f64>(pages1 - pages0) * 65536.0);
  report(<f64>pages1 * 65536.0);
  report(<f64>taskTable.items.length);
}

/** Do suspended task states survive a collection? */
export function m6b_survive_collect(): void {
  __collect();
  __collect();                     // twice: a moving collector needs two passes
  let ok: i32 = 0;
  const n = taskTable.items.length;
  for (let i = 0; i < n; i++) {
    const st = unchecked(taskTable.items[i]);
    const env = st.env;
    if (st.resumePoint == 3 && env != null && unchecked(env).a == i) ok++;
  }
  report(<f64>ok);                 // == n iff every state survived intact
  report(<f64>n);
}

// ── M7: environment across suspension ──────────────────────────────────────
//
// The closures plan's hard case, in its essential form: a captured binding
// mutated after the task is parked must still be visible, and the object must
// not be reclaimed while reachable.

let parkedTask: State1 | null = null;
let parkedEnv: Env1 | null = null;

export function m7_park_then_mutate(): void {
  const env = new Env1();
  env.a = 41;
  const st = new State1();
  st.resumePoint = 1;
  st.env = env;
  parkedTask = st;
  parkedEnv = env;

  // "suspend": drop every local reference, forcing reliance on the root.
  // (We keep module-level roots, which is exactly what the task table is.)
  __collect();
  __collect();

  // "resume": mutate through one path, read through the other.
  const viaEnv = parkedEnv;
  if (viaEnv != null) viaEnv.a = 42;
  let seen = -1;
  const viaTask = parkedTask;
  const taskEnv = viaTask != null ? viaTask.env : null;
  if (taskEnv != null) seen = unchecked(taskEnv).a;
  report(<f64>seen);                // 42 iff env survived AND is shared
}

/** Same, but with no root at all -- must be reclaimed under incremental. */
export function m7b_unrooted_is_reclaimed(): void {
  const pages0 = memory.size();
  for (let round = 0; round < 20; round++) {
    for (let i = 0; i < 5000; i++) {
      const e = new Env1();
      e.a = i;
    }
    __collect();
    __collect();
  }
  const pages1 = memory.size();
  report(<f64>(pages1 - pages0) * 65536.0);   // ~0 under a working collector
  report(<f64>memory.size() * 65536.0);
}

// ── M8: deliberate conservative-scan false positive ────────────────────────
//
// A value on the wasm stack that LOOKS like a pointer to a live object. The
// conservative visitStack scan cannot tell it from a real one, so the object
// is retained. This is the known cost of conservatism; the test exposes it.

export function m8_false_positive(): void {
  __collect();
  __collect();
  const before = memory.size();

  // Allocate an object, take its address as an integer, drop the reference.
  let addr: usize = 0;
  {
    const e = new Env1();
    addr = changetype<usize>(e);
  }
  // `addr` is an integer the collector will mistake for a live pointer if it
  // happens to still be in a scanned stack slot.
  __collect();
  __collect();
  const after = memory.size();

  report(<f64>(after - before) * 65536.0);
  report(<f64>addr);            // nonzero = the address survived as a local
}

// ── M9: grow-failure path ──────────────────────────────────────────────────

export function m9_alloc_until_fail(): void {
  const pages0 = memory.size();
  let grown: i32 = 0;
  let last: i32 = pages0;
  let sink: Env1[] = new Array<Env1>(4096);
  let n: i32 = 0;
  // Grow the heap hard; the host caps maximum memory. If we survive, report
  // how much we got. If we trap, the host reports the trap instead.
  for (let i = 0; i < 400000; i++) {
    const e = new Env1();
    e.a = i;
    unchecked(sink[n] = e);
    if (++n == 4096) n = 0;
    const p = memory.size();
    if (p != last) { grown++; last = p; }
    if (p >= 512) break;         // the session's maximum_pages
  }
  report(<f64>(memory.size() - pages0) * 65536.0);
  report(<f64>grown);
  report(<f64>memory.size() * 65536.0);
}
