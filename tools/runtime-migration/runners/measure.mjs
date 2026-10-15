// Unified measurement runner for the runtime-migration decision.
//
// One runner, one output shape (JSON on stdout, optionally also to OUT_JSON),
// so the Windows driver can assemble a report without parsing prose.
//
//   node measure.mjs <command> <wasm> [args...]
//
// Commands:
//   harness   <wasm> <fn...>            workload suite (reads the result array)
//   retention <wasm>                    R1-R4
//   probe     <wasm>                    p1-p6 local-survival shapes
//   frame     <wasm> <frames> <per> <every>
//   fullgc    <wasm> <live>
//   bigarr    <wasm> <big|many> <n> [per]
//   scale     <wasm> <forced|churn> <live> [allocs]
//
// The guest clock is provided as env.now, milliseconds since process start.
// Anything else the module imports is satisfied with a throwing stub, so an
// unexpected import is loud rather than silent.

import fs from "fs";
import { performance } from "perf_hooks";

const [cmd, file, ...rest] = process.argv.slice(2);
const epoch = performance.now();

const mod = new WebAssembly.Module(fs.readFileSync(file));
const imports = { env: {} };
for (const im of WebAssembly.Module.imports(mod)) {
  imports[im.module] ??= {};
  imports[im.module][im.name] =
    im.name === "now" ? () => performance.now() - epoch
    : im.name === "abort" ? (a, b, c, d) => {
        throw new Error(`guest abort(msg=${a} file=${b} line=${c} col=${d})`);
      }
    : im.name === "console.log" ? () => 0
    : () => { throw new Error(`unexpected import ${im.module}.${im.name}`); };
}

const inst = new WebAssembly.Instance(mod, imports);
const ex = inst.exports;
const mem = () => ex.memory.buffer;
const heapBytes = () => mem().byteLength;

function f64Array(ptrName, lenNameOrCount) {
  const len = typeof lenNameOrCount === "number"
    ? lenNameOrCount
    : Number(ex[lenNameOrCount]());
  if (!len || len <= 0) return [];
  const ptr = Number(ex[ptrName]());
  return Array.from(new Float64Array(mem(), ptr, Math.min(len, 64)));
}

/** Call exactly once, capturing the value or the trap. Stateful probes must
 *  not be invoked twice: a second call measures a warmed heap. */
function once(fn) {
  const t0 = performance.now();
  try { return { value: fn(), trap: null, ms: +(performance.now() - t0).toFixed(3) }; }
  catch (e) { return { value: null, trap: String(e.message ?? e), ms: +(performance.now() - t0).toFixed(3) }; }
}

function trapOf(fn) {
  const t0 = performance.now();
  try { fn(); return { trap: null, ms: +(performance.now() - t0).toFixed(3) }; }
  catch (e) { return { trap: String(e.message ?? e), ms: +(performance.now() - t0).toFixed(3) }; }
}

const out = {
  engine: `node/${process.version}`,
  platform: `${process.platform}/${process.arch}`,
};

switch (cmd) {
  case "harness": {
    const fns = rest.length ? rest : Object.keys(ex).filter((k) => /^m\d/.test(k));
    out.heap_bytes_after_module = heapBytes();
    out.results = {};
    // run the heavy workloads in separate instantiations so one trap does not
    // poison the next: detect per-call instead.
    for (const fn of fns) {
      if (typeof ex[fn] !== "function") { out.results[fn] = { trap: "missing export" }; continue; }
      const r = trapOf(() => { ex.resetResults?.(); ex[fn](); });
      const vals = r.trap ? [] : f64Array("resultPtr", "resultLen");
      out.results[fn] = { ...r, values: vals, heap_bytes: heapBytes() };
    }
    break;
  }
  case "retention": {
    // One call each. These probes allocate; calling twice would measure a
    // warmed heap and understate the growth they exist to expose.
    const r1 = once(() => ex.r1(1));
    const r2 = once(() => ex.r2());
    const r3 = once(() => ex.r3());
    const r4 = once(() => ex.r4());
    out.results = { r1, r2, r3, r4 };
    out.heap_bytes_after_module = heapBytes();
    break;
  }
  case "probe": {
    const expected = { p1: 1234, p2: 4321, p3: 555, p4: 3, p5: 1, p6: 10 };
    out.results = {};
    let pass = 0, n = 0;
    for (const [k, want] of Object.entries(expected)) {
      if (typeof ex[k] !== "function") { out.results[k] = { trap: "missing export" }; continue; }
      n++;
      const r = once(() => ex[k]());
      if (r.trap) { out.results[k] = { trap: r.trap }; continue; }
      const ok = r.value === want;
      if (ok) pass++;
      out.results[k] = { got: r.value, want, ok };
    }
    out.pass = `${pass}/${n}`;
    break;
  }
  case "frame": {
    const [frames, per, every] = rest.map(Number);
    const r = trapOf(() => ex.run(frames, per, every));
    const v = r.trap ? [] : f64Array("rptr", 32);
    // R indices per frame2.ts: 0 worstAlloc 1 totalAlloc 2 worstGC 3 totalGC
    // 4 gcCount 5 over16 6 over8 7 over4 8 over1 9 heapPages
    out.results = {
      trap: r.trap, wall_ms: r.ms,
      worst_alloc_ms: v[0], total_alloc_ms: v[1],
      worst_gc_ms: v[2], total_gc_ms: v[3], gc_count: v[4],
      over16ms: v[5], over8ms: v[6], over4ms: v[7], over1ms: v[8],
      heap_pages: v[9],
      top_stalls_ms: v.slice(10, 18).filter((x) => x > 0),
    };
    break;
  }
  case "fullgc": {
    const n = Number(rest[0]);
    const b = once(() => ex.build(n));
    if (b.trap) { out.results = { trap: b.trap, phase: "build" }; break; }
    const g = once(() => ex.fullCollect());
    out.results = {
      live: ex.liveCount(), full_gc_ms: g.value, heap_pages: ex.heapPages(), trap: g.trap,
    };
    break;
  }
  case "bigarr": {
    const [mode, n, per] = rest;
    const b = once(() => mode === "big"
      ? ex.makeBigArray(Number(n))
      : ex.makeManyArrays(Number(n), Number(per || 16)));
    if (b.trap) { out.results = { trap: b.trap, phase: "build" }; break; }
    const forced = once(() => ex.forced());
    const checked = once(() => ex.churnWorst(20000));
    out.results = {
      mode, n: Number(n),
      forced_full_gc_ms: forced.value,
      worst_alloc_stall_ms: checked.value,
      heap_pages: ex.heapPages(),
    };
    break;
  }
  case "scale": {
    const [op, a, b] = rest;
    if (op === "forced") {
      // build() returns void, so time the two phases separately.
      const built = once(() => ex.build(Number(a)));
      if (built.trap) { out.results = { trap: built.trap, op, phase: "build" }; break; }
      const g = once(() => ex.forcedFullGC());
      out.results = {
        op, live: ex.live(), forced_full_gc_ms: g.value ?? null,
        heap_pages: ex.heapPages(), trap: g.trap,
      };
    } else {
      const r = once(() => ex.churn(Number(a), Number(b)));
      if (r.trap) { out.results = { trap: r.trap, op }; break; }
      out.results = {
        op, live: Number(a), allocs: Number(b),
        worst_alloc_stall_ms: r.value ?? null, heap_pages: ex.heapPages(),
      };
    }
    break;
  }
  default:
    out.error = `unknown command: ${cmd}`;
}

out.file = file.split(/[\\/]/).pop();
const payload = JSON.stringify(out, null, 1);
if (process.env.OUT_JSON) {
  try { fs.writeFileSync(process.env.OUT_JSON, payload); } catch {}
}
process.stdout.write(payload + "\n");
