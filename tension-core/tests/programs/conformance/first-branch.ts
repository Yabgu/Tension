// A branch as the first statement: the line a conditional expression starts on.
import { print } from "../../../../tension-framework";

function choose(flag: bool): void {
  if (flag) { // @stop
    print("taken");
  } else {
    print("not taken");
  }
}

export function _start_game(): void {
  choose(true);
}
