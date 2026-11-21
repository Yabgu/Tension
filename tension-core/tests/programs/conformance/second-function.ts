// Two functions in one file, and the breakpoint in the **second**. A census
// that only ever reads the entry function would call this file healthy.
import { print } from "../../../../tension-framework";

function first(): void {
  print("first");
}

function second(): void {
  print("second"); // @stop
}

export function _start_game(): void {
  first();
  second();
}
