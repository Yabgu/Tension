class Node { v: i32 = 7; next: Node | null = null; }
function makeNode(v: i32): Node { const n = new Node(); n.v = v; return n; }
function inner(): i32 { return 0; }

/** Live object referenced ONLY by a local, across a full collection. */
export function p1(): i32 { const n = makeNode(1234); __collect(); __collect(); return n.v; }

/** Same, but with an intervening call so the local must survive a call. */
export function p2(): i32 { const n = makeNode(4321); inner(); __collect(); __collect(); inner(); return n.v; }

class Holder { n: Node | null = null; }
let holder: Holder = new Holder();

/** Reference held in a managed field under a rooted global. */
export function p3(): i32 { holder.n = makeNode(555); __collect(); __collect(); const h = holder.n; return h != null ? h.v : -1; }

/** Does the collector follow a next-pointer chain? */
export function p4(): i32 {
  const a = makeNode(1); a.next = makeNode(2);
  const b = a.next; if (b != null) b.next = makeNode(3);
  holder.n = a; __collect(); __collect();
  let d = 0; let cur: Node | null = holder.n;
  while (cur != null) { d++; cur = cur.next; }
  return d;
}

/** An integer alias of a live object's address, in a local. */
let keepAlive: Node | null = null;
export function p5(): i32 {
  const n = makeNode(9); keepAlive = n;
  const addr: usize = changetype<usize>(n);
  __collect(); __collect();
  const k = keepAlive;
  return (addr != 0 && k != null && k.v == 9) ? 1 : 0;
}

/** Many live locals at once -- the case a spill exists to protect. */
export function p6(): i32 {
  const a = makeNode(1), b = makeNode(2), c = makeNode(3), d = makeNode(4);
  __collect(); __collect();
  return a.v + b.v + c.v + d.v;
}
