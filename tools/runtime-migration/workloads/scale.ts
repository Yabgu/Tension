class Node { v: i32 = 0; next: Node | null = null; }
@external("env", "now") declare function nowMs(): f64;
let keep: Node[] = new Array<Node>(0);

export function build(n: i32): void { for (let i = 0; i < n; i++) { const x = new Node(); x.v = i; keep.push(x); } }

/** Forced FULL collection over n live objects. */
export function forcedFullGC(): f64 { const t0 = nowMs(); __collect(); const t1 = nowMs(); return t1 - t0; }

/** Churn while n live objects are retained: worst single-allocation stall. */
export function churn(live: i32, allocations: i32): f64 {
  build(live);
  let worst = 0.0;
  let sink: Node[] = new Array<Node>(256);
  for (let i = 0; i < allocations; i++) {
    const t0 = nowMs();
    const x = new Node(); x.v = i;
    const t1 = nowMs();
    if (t1 - t0 > worst) worst = t1 - t0;
    unchecked(sink[i % 256] = x);
  }
  return worst;
}
export function heapPages(): f64 { return <f64>memory.size(); }
export function live(): f64 { return <f64>keep.length; }
