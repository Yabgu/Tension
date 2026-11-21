// The resume point: the statement after an await, in a frame that was
// suspended and resumed. This is the line a debugger has to find in a stack
// that went away and came back.
import { print } from "../../../../tension-framework";

async function yieldPoint(): i32 {
  await 1;
  return 0;
}

async function work(): i32 {
  await yieldPoint();
  print("after await"); // @stop
  return 1;
}

export async function main(): i32 {
  return await work();
}
