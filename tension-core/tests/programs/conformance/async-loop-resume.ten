// Several resume points for one line: an await inside a loop. The first
// resume prints, and the same line is reached again by the second iteration.
import { print } from "../../../../tension-framework";

async function yieldPoint(): i32 {
  await 1;
  return 0;
}

async function work(): i32 {
  for (let i: i32 = 0; i < 3; ++i) {
    await yieldPoint();
    print("resumed " + i.toString()); // @stop
  }
  return 3;
}

export async function main(): i32 {
  return await work();
}
