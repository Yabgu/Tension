// A method and a constructor: two function entries inside one class.
import { print } from "../../../../tension-framework";

class Counter {
  value: i32;

  constructor(start: i32) {
    this.value = start;
    print("constructor"); // @stop2
  }

  bump(): i32 {
    print("method"); // @stop
    this.value += 1;
    return this.value;
  }
}

export function _start_game(): void {
  let counter = new Counter(1);
  print("bumped " + counter.bump().toString());
}
