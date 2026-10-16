// Deliberate attempt to force a conservative-scan false positive.
//
// visitStack (itcms.ts:167-173) walks [__stack_pointer, __heap_base) one word at
// a time and asks __visit whether each word looks like a traced object. It
// cannot distinguish an integer from a pointer, so an integer that happens to
// hold a dead object's address, sitting in a scanned stack slot, should retain
// that object. This workload tries to arrange exactly that.
//
// The signal is HEAP GROWTH. If a stale address is being honoured as a root,
// repeatedly allocating and dropping objects will grow the heap even though
// nothing is reachable. A working collector shows ~0 growth.
//
// A negative result here does NOT prove the scan never produces a false
// positive. It means these particular arrangements did not. State it that way.

class Payload {
  a: i32 = 0;
  b: i32 = 0;
  c: i32 = 0;
  d: i32 = 0;
}

// A call boundary forces the integer to live in a stack slot across it, which is
// where the scan can see it. Returns its argument so nothing is optimised out.
function opaque(x: usize): usize { return x; }

// Module-level escape hatches, so the values are genuinely live rather than
// provably dead at the point of collection.
let addrSink: usize = 0;
let intArraySink: usize[] = new Array<usize>(0);

/**
 * Strategy 1: one dead object's address, held in a local across a call, then a
 * collection. Returns heap growth in bytes over `rounds` repetitions.
 */
export function fp1_localAlias(rounds: i32): i32 {
  const p0 = memory.size();
  for (let i = 0; i < rounds; i++) {
    const dead = new Payload();
    dead.a = i;
    const addr = changetype<usize>(dead);
    addrSink = addr;
    // keep `addr` on the stack across a call
    opaque(addr);
    opaque(addr);
    __collect();
    __collect();
    // fresh allocation: reuses the freed block if the collector did its job
    const t = new Payload();
    t.a = i;
    opaque(changetype<usize>(t));
  }
  return (memory.size() - p0) * 65536;
}

/**
 * Strategy 2: an array of dead addresses, all live on the stack at once, so the
 * scan has many chances to mistake one for a pointer.
 */
export function fp2_manyAliases(rounds: i32, width: i32): i32 {
  const p0 = memory.size();
  for (let i = 0; i < rounds; i++) {
    let addrs = new StaticArray<usize>(width);
    for (let j = 0; j < width; j++) {
      const dead = new Payload();
      dead.a = j;
      unchecked(addrs[j] = changetype<usize>(dead));
    }
    for (let j = 0; j < width; j++) opaque(unchecked(addrs[j]));
    __collect();
    __collect();
    for (let j = 0; j < width; j++) opaque(unchecked(addrs[j]));
    const t = new Payload();
    t.a = i;
    opaque(changetype<usize>(t));
  }
  return (memory.size() - p0) * 65536;
}

/**
 * Strategy 3: an address captured while the object was alive, kept live
 * indefinitely in an array that the stack scan can see.
 */
export function fp3_pinnedInts(n: i32): i32 {
  const p0 = memory.size();
  for (let i = 0; i < n; i++) {
    const live = new Payload();
    live.a = i;
    intArraySink.push(changetype<usize>(live));
  }
  __collect();
  __collect();
  return (memory.size() - p0) * 65536;
}

/**
 * Strategy 4 (the control): the same allocation volume with NO aliasing at all.
 * If this and fp1 grow by the same amount, the growth is ordinary overhead and
 * says nothing about the scan.
 */
export function fp4_control(rounds: i32): i32 {
  const p0 = memory.size();
  for (let i = 0; i < rounds; i++) {
    const dead = new Payload();
    dead.a = i;
    __collect();
    __collect();
    const t = new Payload();
    t.a = i;
  }
  return (memory.size() - p0) * 65536;
}

export function heapPages(): i32 { return memory.size(); }
export function addrSinkValue(): usize { return addrSink; }
export function intArrayLen(): i32 { return intArraySink.length; }
