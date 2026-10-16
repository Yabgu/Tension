class Node { v: i32 = 0; next: Node | null = null; }
@external("env", "now") declare function nowMs(): f64;
let keep: Node[] = new Array<Node>(0);
export function build(n: i32): void { for (let i = 0; i < n; i++) { const x = new Node(); x.v = i; keep.push(x); } }
export function fullCollect(): f64 {
  const t0 = nowMs(); __collect(); const t1 = nowMs(); return t1 - t0;
}
export function heapPages(): f64 { return <f64>memory.size(); }
export function liveCount(): f64 { return <f64>keep.length; }
/** Worst-case: full collection over a large LIVE set. */
export function scenario(n: i32): void {
  build(n);
  const live = liveCount(), p0 = heapPages();
  const gc = fullCollect();
  const p1 = heapPages();
  console.log("live=" + live.toString() + " heapBefore=" + p0.toString()
    + " heapAfter=" + p1.toString() + " fullGC_ms=" + gc.toString());
}
