// A nested suspension: `outer` awaits `inner`, and the breakpoint is after the
// second resume. `_start_game` is the engine's entry; `main` is the root
// continuation the shell resumes, so this is the examples' own path.
import { print } from "../../../../tension-framework";

async function inner(v: i32): i32 {
  await 1;
  return v + 1;
}

async function outer(v: i32): i32 {
  let r = await inner(v);
  print("outer resumed " + r.toString()); // @stop
  return r;
}

export async function main(): i32 {
  return await outer(41);
}
