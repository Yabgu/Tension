class Env1 { a: i32 = 0; }
class State1 { resumePoint: u32 = 0; status: i32 = 0; env: Env1 | null = null; }

let tasks: State1[] = new Array<State1>(0);
let parked: State1 | null = null;
let parkedEnv: Env1 | null = null;

/** R1: 10k suspended tasks + survive a full collection. Returns intact count. */
export function r1(collect: i32): i32 {
  for (let i = 0; i < 10000; i++) {
    const e = new Env1(); e.a = i;
    const s = new State1(); s.resumePoint = 3; s.env = e;
    tasks.push(s);
  }
  if (collect) { __collect(); __collect(); }
  let ok = 0; const n = tasks.length;
  for (let i = 0; i < n; i++) {
    const s = unchecked(tasks[i]); const e = s.env;
    if (s.resumePoint == 3 && e != null && unchecked(e).a == i) ok++;
  }
  return ok;
}

/** R2: park an env, collect, mutate through one path, read through the other. */
export function r2(): i32 {
  const env = new Env1(); env.a = 41;
  const s = new State1(); s.resumePoint = 1; s.env = env;
  parked = s; parkedEnv = env;
  __collect(); __collect();
  const pe = parkedEnv; if (pe != null) pe.a = 42;
  const ps = parked; const se = ps != null ? ps.env : null;
  return se != null ? unchecked(se).a : -1;
}

/** R3: unrooted envs must be reclaimed. Returns heap growth in bytes. */
export function r3(): i32 {
  const p0 = memory.size();
  for (let round = 0; round < 20; round++) {
    for (let i = 0; i < 5000; i++) { const e = new Env1(); e.a = i; }
    __collect(); __collect();
  }
  return (memory.size() - p0) * 65536;
}

/** R4: an object held only by a local must NOT be reclaimed. */
class Node { v: i32 = 7; }
export function r4(): i32 { const n = new Node(); __collect(); __collect(); return n.v; }
