// An async body's statement **before** its first await: it runs on the first
// resume of the task, in the frame that will later be suspended.
import { print } from "../../../../tension-framework";

async function yieldPoint(): i32 {
  await 1;
  return 0;
}

async function work(): i32 {
  print("before await"); // @stop
  await yieldPoint();
  print("after await");
  return 1;
}

export async function main(): i32 {
  return await work();
}
