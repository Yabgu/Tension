// The most common breakpoint there is: the first statement of a function.
// A prologue that carries no line of its own is what swallows it, so this case
// is the smallest thing that can show the swallow.
import { print } from "../../../../tension-framework";

function greet(): void {
  print("first statement"); // @stop
}

export function _start_game(): void {
  greet();
}
