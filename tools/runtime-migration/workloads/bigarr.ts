class Node { v: i32 = 0; }
@external("env", "now") declare function nowMs(): f64;
let big: Node[] | null = null;
let many: Array<Node[]> = new Array<Node[]>(0);

/** One huge array of references: marking it is ONE gc step. */
export function makeBigArray(n: i32): void {
  const a = new Array<Node>(n);
  for (let i = 0; i < n; i++) { const x = new Node(); x.v = i; unchecked(a[i] = x); }
  big = a;
}
/** Same object count, spread over many small arrays. */
export function makeManyArrays(n: i32, perArray: i32): void {
  const na = n / perArray;
  for (let k = 0; k < na; k++) {
    const a = new Array<Node>(perArray);
    for (let i = 0; i < perArray; i++) { const x = new Node(); x.v = i; unchecked(a[i] = x); }
    many.push(a);
  }
}

/** Time one allocation that may run a gc step, with either shape retained. */
export function churnWorst(allocs: i32): f64 {
  __collect();                       // start from a clean cycle state
  let worst = 0.0;
  let sink: Node[] = new Array<Node>(64);
  for (let i = 0; i < allocs; i++) {
    const t0 = nowMs();
    const x = new Node(); x.v = i;
    const t1 = nowMs();
    if (t1 - t0 > worst) worst = t1 - t0;
    unchecked(sink[i % 64] = x);
  }
  return worst;
}
export function heapPages(): f64 { return <f64>memory.size(); }
export function forced(): f64 { const t0 = nowMs(); __collect(); return nowMs() - t0; }
