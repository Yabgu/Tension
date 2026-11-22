// The same program, importing only `io` — whose three functions contain no
// `await`. This is the control for promise-main-framework.ts: one import
// changed, nothing else.
import { print } from "tension-framework/assembly/io";

export async function main(): i32 {
  print("io only: main ran\n");
  return 1;
}
