// A closure body: an anonymous function with its own entry and its own line.
import { print } from "../../../../tension-framework";

function each(body: () => i32): i32 {
  return body();
}

export function _start_game(): void {
  let value = each((): i32 => {
    print("lambda body"); // @stop
    return 7;
  });
  print("lambda returned " + value.toString());
}
