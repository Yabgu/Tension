// The same statement, one step later: three declarations first, so the
// function's prologue has real work in it. If the hole is about a prologue's
// length rather than about the first statement, this case separates the two.
import { print } from "../../../../tension-framework";

function compute(): void {
  let a: i32 = 2;
  let b: i32 = 3;
  let sum: i32 = a + b;
  print("after declarations " + sum.toString()); // @stop
}

export function _start_game(): void {
  compute();
}
